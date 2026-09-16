import { adapterError, createAdapterResult } from "../core/adapter-result.mjs";
import {
  sanitizeRecord,
  sanitizeUrlForRecord,
} from "../security/record-sanitizer.mjs";

const DEFAULT_USER_AGENT =
  "SearchGrowthOS/0.2 technical-audit crawler (+https://github.com/wuzhxxi/search-growth-os)";

export const CRAWLER_LIMITS = Object.freeze({
  maxPages: 1_000,
  concurrency: 10,
  timeoutMs: 60_000,
  redirectLimit: 10,
  maxLinksPerPage: 500,
  maxUrlBytes: 8_192,
  maxDiscoveredUrls: 50_000,
  maxRetainedLinkBytes: 8 * 1024 * 1024,
});

export const DEFAULT_CRAWL_CONFIG = Object.freeze({
  maxPages: 50,
  concurrency: 2,
  timeoutMs: 10_000,
  redirectLimit: 5,
  maxLinksPerPage: 250,
  userAgent: DEFAULT_USER_AGENT,
});

export const CRAWLER_ADAPTER = Object.freeze({
  id: "bounded-technical-crawler",
  name: "Bounded same-origin technical crawler",
  version: "0.2.0",
  capabilities: Object.freeze([
    "same-origin-crawl",
    "bounded-concurrency",
    "robots-policy-hook",
    "technical-issue-candidates",
  ]),
});

const ERROR_STATES = new Set(["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"]);

/**
 * Crawl a site using an injected HTTP adapter.
 *
 * The adapter can be either `(url, requestConfig) => result` or an object with
 * `inspect({ url, ...requestConfig })`. Its result may be the HTTP output itself
 * or a Tool Adapter envelope containing `output` and `errors`.
 */
export async function crawlSite(targetUrl, options = {}) {
  let output;
  try {
    output = await crawlSiteOutput(targetUrl, options);
  } catch (error) {
    const observedAt = safeIsoNow(options.now);
    return createAdapterResult({
      adapter: CRAWLER_ADAPTER,
      status: "invalid",
      input: { target_url: serializableTarget(targetUrl) },
      output: null,
      evidence: [],
      observedAt,
      errors: [
        adapterError("CRAWLER_INVALID_INPUT", safeMessage(error), {
          status: "invalid",
          stage: "crawler_configuration",
        }),
      ],
    });
  }

  const status = resultStatus(output);
  return createAdapterResult({
    adapter: CRAWLER_ADAPTER,
    status,
    input: {
      target_url: output.target,
      configuration: output.configuration,
    },
    output,
    evidence: output.pages.map(pageEvidence),
    observedAt: output.completed_at,
    errors: output.errors.map((error) =>
      adapterError(
        `CRAWLER_${String(error.stage ?? "unknown").toUpperCase()}_${String(error.status ?? "UNKNOWN").toUpperCase()}`,
        error.message,
        {
          status: error.status,
          stage: error.stage,
          url: error.url,
          crawl_depth: error.crawl_depth,
        },
      ),
    ),
  });
}

/** Raw deterministic crawl output used by the unified crawler adapter. */
export async function crawlSiteOutput(targetUrl, options = {}) {
  const target = normalizeHttpUrl(targetUrl);
  if (!target) throw new TypeError("targetUrl must be an absolute http or https URL");

  const httpAdapter = options.httpAdapter;
  if (typeof httpAdapter !== "function" && typeof httpAdapter?.inspect !== "function") {
    throw new TypeError("httpAdapter must be a function or expose inspect(input)");
  }

  const config = buildConfig(options);
  if (typeof options.robotsPolicy !== "function") {
    throw new TypeError(
      "robotsPolicy is required; the crawler will not default to an allow-all policy",
    );
  }
  const targetOrigin = new URL(target).origin;
  const importantUrls = normalizeUrlSet(options.importantUrls ?? [target], target);
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const startedAt = isoNow(now);

  const queue = [{ url: target, depth: 0, discoveredFrom: null }];
  const enqueued = new Set([target]);
  const seen = new Set();
  const discovered = new Set([target]);
  const inboundSources = new Map();
  const pages = [];
  const errors = [];
  const skipped = [];
  const linkBudget = {count: 0, bytes: 0, limitHit: false};
  let aggregateLimitReported = false;
  let accessControlHalt = null;
  let consideredPages = 0;
  let adapterRequests = 0;

  while (queue.length > 0 && consideredPages < config.maxPages) {
    const batch = [];
    while (
      queue.length > 0 &&
      batch.length < config.concurrency &&
      consideredPages + batch.length < config.maxPages
    ) {
      const candidate = queue.shift();
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      batch.push(candidate);
    }
    if (batch.length === 0) continue;
    consideredPages += batch.length;

    const observations = await Promise.all(
      batch.map(async (candidate) => {
        const policy = await evaluateRobotsPolicy(options.robotsPolicy, candidate, {
          target,
          targetOrigin,
          userAgent: config.userAgent,
        });
        if (!policy.allowed) return { candidate, policy };

        adapterRequests += 1;
        try {
          const raw = await invokeHttpAdapter(httpAdapter, candidate.url, {
            timeoutMs: config.timeoutMs,
            timeout_ms: config.timeoutMs,
            redirectLimit: config.redirectLimit,
            maxRedirects: config.redirectLimit,
            max_redirects: config.redirectLimit,
            userAgent: config.userAgent,
            user_agent: config.userAgent,
            method: "GET",
            sameOriginOnly: true,
            allowedOrigin: targetOrigin,
            allowedOrigins: [targetOrigin],
            allowRedirect: async (_from, to) => {
              if (!isSameOrigin(to, targetOrigin)) return false;
              const redirectPolicy = await evaluateRobotsPolicy(
                options.robotsPolicy,
                {
                  url: to,
                  depth: candidate.depth,
                  discoveredFrom: candidate.discoveredFrom,
                },
                {
                  target,
                  targetOrigin,
                  userAgent: config.userAgent,
                  redirect: true,
                },
              );
              return redirectPolicy.allowed === true;
            },
          });
          return { candidate, raw };
        } catch (error) {
          return {
            candidate,
            thrown: {
              status: normalizeErrorState(error?.code ?? error?.status),
              message: safeMessage(error),
            },
          };
        }
      }),
    );

    for (const observation of observations) {
      const { candidate } = observation;
      if (observation.policy && !observation.policy.allowed) {
        if (observation.policy.error) {
          errors.push({
            url: candidate.url,
            crawl_depth: candidate.depth,
            status: observation.policy.status,
            stage: "robots_policy",
            message: observation.policy.error,
          });
        }
        skipped.push({
          url: candidate.url,
          crawl_depth: candidate.depth,
          status: observation.policy.status,
          reason: observation.policy.reason,
        });
        continue;
      }

      if (observation.thrown) {
        errors.push({
          url: candidate.url,
          crawl_depth: candidate.depth,
          status: observation.thrown.status,
          stage: "http",
          message: observation.thrown.message,
        });
        continue;
      }

      const envelope = normalizeAdapterEnvelope(observation.raw);
      const observedAt = readObservedAt(observation.raw) ?? isoNow(now);
      for (const adapterError of envelope.errors) {
        errors.push({
          url: candidate.url,
          crawl_depth: candidate.depth,
          status: normalizeErrorState(
            adapterError?.status ?? envelope.status ?? adapterError?.code,
          ),
          stage: "http",
          message: safeMessage(adapterError),
        });
      }

      if (!envelope.output || typeof envelope.output !== "object") {
        if (envelope.errors.length === 0) {
          errors.push({
            url: candidate.url,
            crawl_depth: candidate.depth,
            status: "unavailable",
            stage: "http",
            message: "HTTP adapter returned no structured output",
          });
        }
        continue;
      }

      if (!hasPageObservation(envelope.output)) continue;

      const page = normalizePage(
        envelope.output,
        candidate,
        targetOrigin,
        observedAt,
        config.maxLinksPerPage,
        linkBudget,
      );
      pages.push(page);

      if (linkBudget.limitHit && !aggregateLimitReported) {
        aggregateLimitReported = true;
        errors.push({
          url: page.requested_url,
          crawl_depth: page.crawl_depth,
          status: "unavailable",
          stage: "crawler_limits",
          message: "Aggregate discovered URL or retained link-byte limit reached",
        });
      }

      if ([401, 403, 429].includes(page.http_status)) {
        accessControlHalt = {
          url: page.final_url ?? page.requested_url,
          http_status: page.http_status,
          retry_after: page.retry_after,
        };
        errors.push({
          url: page.requested_url,
          crawl_depth: page.crawl_depth,
          status: "blocked",
          stage: "access_control",
          message: `Crawl stopped after HTTP ${page.http_status}; access-control and rate-limit responses are not bypassed`,
        });
      }

      addSameOriginAliases(seen, page, targetOrigin);
      if (isSameOrigin(page.final_url, targetOrigin)) discovered.add(page.final_url);

      if (!isExpandableHtmlPage(page) || accessControlHalt) continue;
      for (let index = 0; index < page.internal_links.length; index += 1) {
        const link = page.internal_links[index];
        discovered.add(link);
        addInboundSource(inboundSources, link, page.final_url ?? page.requested_url);
        if (!enqueued.has(link) && !seen.has(link)) {
          enqueued.add(link);
          queue.push({
            url: link,
            depth: candidate.depth + 1,
            discoveredFrom: page.final_url ?? page.requested_url,
          });
        }
      }
    }
    if (accessControlHalt) {
      queue.length = 0;
      break;
    }
  }

  const completedAt = isoNow(now);
  const issues = deriveCrawlIssues(pages, {
    importantUrls,
    inboundSources,
    source: CRAWLER_ADAPTER.id,
  });

  return sanitizeRecord({
    target,
    origin: targetOrigin,
    started_at: startedAt,
    completed_at: completedAt,
    configuration: {
      max_pages: config.maxPages,
      concurrency: config.concurrency,
      timeout_ms: config.timeoutMs,
      redirect_limit: config.redirectLimit,
      max_links_per_page: config.maxLinksPerPage,
      max_url_bytes: CRAWLER_LIMITS.maxUrlBytes,
      max_discovered_urls: CRAWLER_LIMITS.maxDiscoveredUrls,
      max_retained_link_bytes: CRAWLER_LIMITS.maxRetainedLinkBytes,
      user_agent: config.userAgent,
      same_origin_only: true,
    },
    pages,
    discovered_urls: [...discovered],
    skipped,
    errors,
    issues,
    summary: {
      pages_considered: consideredPages,
      requests_made: adapterRequests,
      pages_observed: pages.length,
      urls_discovered: discovered.size,
      skipped: skipped.length,
      errors: errors.length,
      issues: issues.length,
      page_limit_reached: consideredPages >= config.maxPages && queue.length > 0,
      queued_but_not_crawled: queue.length,
      retained_link_bytes: linkBudget.bytes,
      discovered_url_limit_hit: linkBudget.limitHit,
      halted_by_access_control: accessControlHalt,
    },
  });
}

/** Create a reusable crawler with injected defaults. */
export function createCrawler(defaultOptions = {}) {
  return Object.freeze({
    ...CRAWLER_ADAPTER,
    async crawl(input, runtimeOptions = {}) {
      const request = typeof input === "string" ? { targetUrl: input } : input ?? {};
      const targetUrl = request.targetUrl ?? request.target_url ?? request.url;
      return crawlSite(targetUrl, {
        ...defaultOptions,
        ...request,
        ...runtimeOptions,
        httpAdapter:
          runtimeOptions.httpAdapter ?? request.httpAdapter ?? defaultOptions.httpAdapter,
        robotsPolicy:
          runtimeOptions.robotsPolicy ?? request.robotsPolicy ?? defaultOptions.robotsPolicy,
      });
    },
  });
}

/**
 * Derive only directly-supported technical issue candidates from crawl facts.
 */
export function deriveCrawlIssues(pages, options = {}) {
  const importantUrls = normalizeUrlSet(options.importantUrls ?? [], pages?.[0]?.requested_url);
  const inboundSources = asInboundMap(options.inboundSources);
  const source = options.source ?? CRAWLER_ADAPTER.id;
  const issues = [];

  for (const page of Array.isArray(pages) ? pages : []) {
    const requestedUrl = normalizeHttpUrl(page?.requested_url ?? page?.url);
    if (!requestedUrl) continue;
    const finalUrl = normalizeHttpUrl(page?.final_url) ?? requestedUrl;
    const status = finiteHttpStatus(page?.http_status ?? page?.status);
    const observedAt = typeof page?.observed_at === "string" ? page.observed_at : null;
    const sources = [...(inboundSources.get(requestedUrl) ?? [])];

    if (status !== null && status >= 400 && sources.length > 0) {
      issues.push(
        factualIssue("broken_internal_link", requestedUrl, observedAt, source, {
          http_status: status,
          source_urls: sources,
          notes: `${requestedUrl} returned HTTP ${status} after being linked internally.`,
        }),
      );
    }

    if (status !== null && (status < 200 || status >= 300) && importantUrls.has(requestedUrl)) {
      issues.push(
        factualIssue("non_2xx_important_url", requestedUrl, observedAt, source, {
          http_status: status,
          notes: `Important URL ${requestedUrl} returned HTTP ${status}.`,
        }),
      );
    }

    const redirectChain = Array.isArray(page?.redirect_chain) ? page.redirect_chain : [];
    if (redirectChain.length > 0 || finalUrl !== requestedUrl) {
      issues.push(
        factualIssue("redirect_chain", requestedUrl, observedAt, source, {
          final_url: finalUrl,
          hop_count: redirectChain.length,
          redirect_chain: redirectChain,
          notes: `${requestedUrl} resolved to ${finalUrl} with ${redirectChain.length} recorded redirect hop(s).`,
        }),
      );
    }

    const canonical = resolvePageUrl(page?.canonical, finalUrl);
    if (canonical && canonical !== finalUrl) {
      issues.push(
        factualIssue("canonical_difference", requestedUrl, observedAt, source, {
          final_url: finalUrl,
          canonical,
          notes: `${finalUrl} declares a different canonical URL: ${canonical}.`,
        }),
      );
    }

    const robotsValue = [page?.meta_robots, page?.x_robots_tag]
      .map(flattenDirectiveValue)
      .join(",");
    if (hasDirective(robotsValue, "noindex")) {
      issues.push(
        factualIssue("noindex", requestedUrl, observedAt, source, {
          meta_robots: page.meta_robots,
          x_robots_tag: page.x_robots_tag ?? null,
          notes: `${finalUrl} contains an observed noindex robots directive.`,
        }),
      );
    }
  }

  return issues;
}

/**
 * Compare a scoped sitemap set with URLs discovered by a crawl. These are
 * candidates, never assertions that a URL is globally orphaned.
 */
export function findOrphanCandidates(sitemapUrls, discoveredUrls, options = {}) {
  const origin = normalizeOrigin(options.origin);
  const sitemap = normalizeCollection(sitemapUrls, origin);
  const discovered = normalizeCollection(discoveredUrls, origin);

  return [...sitemap]
    .filter((url) => !discovered.has(url))
    .sort()
    .map((url) => ({
      type: "orphan_candidate",
      classification: "CANDIDATE",
      conclusion: "INFERRED",
      scope: "sitemap_urls_not_in_discovered_url_set",
      url,
      evidence_state: "INFERRED",
      evidence: {
        state: "OBSERVED",
        listed_in_supplied_sitemap_scope: true,
        present_in_supplied_discovery_scope: false,
      },
      limitation:
        "Candidate only: the bounded crawl and supplied sitemap set do not prove that no other internal link exists.",
    }));
}

function resultStatus(output) {
  if (output.pages.length > 0) {
    return output.errors.length > 0 ||
      output.skipped.length > 0 ||
      output.summary.page_limit_reached
      ? "partial"
      : "ok";
  }
  if (output.skipped.length > 0 && output.errors.length === 0) return "blocked";
  const states = new Set(output.errors.map((error) => error.status));
  if (states.size === 1 && states.has("timeout")) return "timeout";
  if (states.size === 1 && states.has("blocked")) return "blocked";
  if (states.size === 1 && states.has("invalid")) return "invalid";
  return output.errors.length > 0 ? "unavailable" : "ok";
}

function pageEvidence(page) {
  const status = page.http_status === null ? "an unknown HTTP status" : `HTTP ${page.http_status}`;
  return {
    state: "OBSERVED",
    source: `${CRAWLER_ADAPTER.id}:${page.requested_url}`,
    observed_at: page.observed_at,
    notes: `${page.requested_url} produced ${status}; final URL ${page.final_url}.`,
  };
}

function buildConfig(options) {
  const userAgent = nonEmptyString(options.userAgent ?? options.user_agent, DEFAULT_USER_AGENT);
  if (userAgent.length > 512 || /[\u0000-\u001f\u007f]/u.test(userAgent)) {
    throw new RangeError("userAgent must be a header-safe string of at most 512 characters");
  }
  return {
    maxPages: boundedInteger(
      options.maxPages ?? options.max_pages,
      DEFAULT_CRAWL_CONFIG.maxPages,
      1,
      CRAWLER_LIMITS.maxPages,
      "maxPages",
    ),
    concurrency: boundedInteger(
      options.concurrency,
      DEFAULT_CRAWL_CONFIG.concurrency,
      1,
      CRAWLER_LIMITS.concurrency,
      "concurrency",
    ),
    timeoutMs: boundedInteger(
      options.timeoutMs ?? options.timeout_ms,
      DEFAULT_CRAWL_CONFIG.timeoutMs,
      1,
      CRAWLER_LIMITS.timeoutMs,
      "timeoutMs",
    ),
    redirectLimit: boundedInteger(
      options.redirectLimit ?? options.redirect_limit ?? options.maxRedirects,
      DEFAULT_CRAWL_CONFIG.redirectLimit,
      0,
      CRAWLER_LIMITS.redirectLimit,
      "redirectLimit",
    ),
    maxLinksPerPage: boundedInteger(
      options.maxLinksPerPage ?? options.max_links_per_page,
      DEFAULT_CRAWL_CONFIG.maxLinksPerPage,
      1,
      CRAWLER_LIMITS.maxLinksPerPage,
      "maxLinksPerPage",
    ),
    userAgent,
  };
}

async function invokeHttpAdapter(adapter, url, requestConfig) {
  if (typeof adapter === "function") return adapter(url, requestConfig);
  return adapter.inspect({ url, ...requestConfig });
}

async function evaluateRobotsPolicy(policy, candidate, context) {
  if (typeof policy !== "function") {
    return {
      allowed: false,
      status: "unavailable",
      reason: "robots_policy_unavailable",
      error: "robotsPolicy is required",
    };
  }
  try {
    const decision = await policy(candidate.url, {
      ...context,
      crawlDepth: candidate.depth,
      discoveredFrom: candidate.discoveredFrom,
    });
    if (decision === false) {
      return { allowed: false, status: "blocked", reason: "robots_disallowed" };
    }
    if (decision === true) {
      return { allowed: true, status: "allowed", reason: "robots_allowed" };
    }
    if (decision && typeof decision === "object" && decision.allowed === true) {
      return {
        allowed: true,
        status: "allowed",
        reason: nonEmptyString(decision.reason, "robots_allowed"),
      };
    }
    if (decision && typeof decision === "object" && decision.allowed === false) {
      return {
        allowed: false,
        status: normalizeErrorState(decision.status ?? "blocked"),
        reason: nonEmptyString(decision.reason, "robots_disallowed"),
      };
    }
    return {
      allowed: false,
      status: "unavailable",
      reason: "robots_policy_indeterminate",
      error: "robotsPolicy must explicitly return true or {allowed: true}",
    };
  } catch (error) {
    return {
      allowed: false,
      status: "unavailable",
      reason: "robots_policy_error",
      error: safeMessage(error),
    };
  }
}

function normalizeAdapterEnvelope(raw) {
  if (!raw || typeof raw !== "object") return { output: null, errors: [], status: null };
  const hasEnvelope = Object.hasOwn(raw, "output") || Object.hasOwn(raw, "errors");
  const errors = Array.isArray(raw.errors) ? raw.errors : raw.error ? [raw.error] : [];
  return {
    output: hasEnvelope ? raw.output : raw,
    errors,
    status: typeof raw.status === "string" ? raw.status : null,
  };
}

function hasPageObservation(output) {
  const chain = output.redirect_chain ?? output.redirectChain;
  return (
    finiteHttpStatus(output.http_status ?? output.httpStatus ?? output.status) !== null ||
    (Array.isArray(chain) && chain.length > 0) ||
    normalizeHttpUrl(output.final_url ?? output.finalUrl) !== null
  );
}

function normalizePage(
  output,
  candidate,
  targetOrigin,
  observedAt,
  maxLinksPerPage,
  linkBudget,
) {
  const parsed = output.parsed && typeof output.parsed === "object" ? output.parsed : {};
  const requestedUrl =
    normalizeHttpUrl(output.requested_url ?? output.requestedUrl) ?? candidate.url;
  const finalUrl = normalizeHttpUrl(output.final_url ?? output.finalUrl) ?? requestedUrl;
  const linkBase = isSameOrigin(finalUrl, targetOrigin) ? finalUrl : requestedUrl;
  const rawLinks =
    output.internal_links ?? output.internalLinks ?? parsed.internal_links ?? parsed.internalLinks ?? [];
  const internalLinks = [];
  const uniqueLinks = new Set();
  for (const rawLink of Array.isArray(rawLinks) ? rawLinks : []) {
    const href =
      typeof rawLink === "string"
        ? rawLink
        : rawLink?.url ?? rawLink?.href ?? rawLink?.resolved_url ?? rawLink?.resolvedUrl;
    if (typeof href === "string" && Buffer.byteLength(href) > CRAWLER_LIMITS.maxUrlBytes) {
      linkBudget.limitHit = true;
      continue;
    }
    const link = resolvePageUrl(href, linkBase);
    if (!link || !isSameOrigin(link, targetOrigin) || uniqueLinks.has(link)) continue;
    const linkBytes = Buffer.byteLength(link);
    if (
      linkBudget.count >= CRAWLER_LIMITS.maxDiscoveredUrls ||
      linkBudget.bytes + linkBytes > CRAWLER_LIMITS.maxRetainedLinkBytes
    ) {
      linkBudget.limitHit = true;
      break;
    }
    uniqueLinks.add(link);
    internalLinks.push(link);
    linkBudget.count += 1;
    linkBudget.bytes += linkBytes;
    if (internalLinks.length >= maxLinksPerPage) break;
  }

  const redirectChain = Array.isArray(output.redirect_chain ?? output.redirectChain)
    ? structuredCloneSafe(output.redirect_chain ?? output.redirectChain)
    : [];

  return {
    url: requestedUrl,
    requested_url: requestedUrl,
    final_url: finalUrl,
    http_status: finiteHttpStatus(output.http_status ?? output.httpStatus ?? output.status),
    title: nullableString(output.title ?? parsed.title),
    canonical: nullableString(output.canonical ?? parsed.canonical),
    meta_robots: cloneValue(output.meta_robots ?? output.metaRobots ?? parsed.meta_robots ?? null),
    x_robots_tag: cloneValue(output.x_robots_tag ?? output.xRobotsTag ?? null),
    content_type: nullableString(output.content_type ?? output.contentType),
    retry_after: nullableString(output.headers?.["retry-after"]),
    internal_links: internalLinks,
    internal_links_truncated:
      (Array.isArray(rawLinks) && rawLinks.length > maxLinksPerPage) || linkBudget.limitHit,
    redirect_chain: redirectChain,
    redirect: redirectChain.length > 0 || finalUrl !== requestedUrl,
    crawl_depth: candidate.depth,
    discovered_from: candidate.discoveredFrom ? [candidate.discoveredFrom] : [],
    observed_at: observedAt,
  };
}

function isExpandableHtmlPage(page) {
  if (!Number.isInteger(page.http_status) || page.http_status < 200 || page.http_status >= 300) {
    return false;
  }
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(page.content_type ?? "")) {
    return true;
  }
  return page.content_type === null && page.internal_links.length > 0;
}

function addSameOriginAliases(seen, page, origin) {
  for (const value of [page.final_url, ...redirectUrls(page.redirect_chain)]) {
    const normalized = normalizeHttpUrl(value);
    if (normalized && isSameOrigin(normalized, origin)) seen.add(normalized);
  }
}

function redirectUrls(chain) {
  const urls = [];
  for (const hop of Array.isArray(chain) ? chain : []) {
    if (typeof hop === "string") {
      urls.push(hop);
      continue;
    }
    if (!hop || typeof hop !== "object") continue;
    urls.push(hop.url, hop.requested_url, hop.final_url);
  }
  return urls.filter(Boolean);
}

function factualIssue(type, url, observedAt, source, details) {
  const { notes, ...facts } = details;
  return {
    id: `${type}:${url}`,
    type,
    classification: "OBSERVED",
    url,
    ...facts,
    evidence: {
      state: "OBSERVED",
      source,
      observed_at: observedAt,
      notes,
    },
  };
}

function normalizeCollection(values, origin) {
  const normalized = new Set();
  for (const value of Array.isArray(values) ? values : values instanceof Set ? values : []) {
    const candidates = extractUrls(value);
    for (const candidate of candidates) {
      const url = normalizeHttpUrl(candidate);
      if (url && (!origin || isSameOrigin(url, origin))) normalized.add(url);
    }
  }
  return normalized;
}

function extractUrls(value) {
  if (typeof value === "string" || value instanceof URL) return [String(value)];
  if (!value || typeof value !== "object") return [];
  return [value.url, value.requested_url, value.final_url].filter(Boolean);
}

function normalizeUrlSet(values, base) {
  const normalized = new Set();
  const list = Array.isArray(values) || values instanceof Set ? values : [values];
  for (const value of list) {
    const url = resolvePageUrl(value, base);
    if (url) normalized.add(url);
  }
  return normalized;
}

function asInboundMap(value) {
  if (value instanceof Map) return value;
  const map = new Map();
  if (!value || typeof value !== "object") return map;
  for (const [url, sources] of Object.entries(value)) {
    map.set(url, new Set(Array.isArray(sources) ? sources : [sources]));
  }
  return map;
}

function addInboundSource(map, url, source) {
  if (!map.has(url)) map.set(url, new Set());
  map.get(url).add(source);
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" && !(value instanceof URL)) return null;
  try {
    if (Buffer.byteLength(String(value)) > CRAWLER_LIMITS.maxUrlBytes) return null;
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function resolvePageUrl(value, base) {
  if (typeof value !== "string" && !(value instanceof URL)) return null;
  try {
    const url = base ? new URL(String(value), String(base)) : new URL(String(value));
    return normalizeHttpUrl(url);
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  if (!value) return null;
  const normalized = normalizeHttpUrl(value);
  return normalized ? new URL(normalized).origin : null;
}

function isSameOrigin(value, origin) {
  const normalized = normalizeHttpUrl(value);
  return Boolean(normalized && new URL(normalized).origin === origin);
}

function finiteHttpStatus(value) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function flattenDirectiveValue(value) {
  if (Array.isArray(value)) return value.map(flattenDirectiveValue).join(",");
  if (value && typeof value === "object") return Object.values(value).map(flattenDirectiveValue).join(",");
  return typeof value === "string" ? value : "";
}

function hasDirective(value, expected) {
  return value
    .toLowerCase()
    .split(/[;,]/u)
    .map((part) => part.trim().split(/\s+/u)[0])
    .includes(expected);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function nonEmptyString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeErrorState(value) {
  if (typeof value !== "string") return "UNKNOWN";
  const lower = value.toLowerCase();
  if (lower.includes("timeout") || lower === "etimedout" || lower === "abort_err") return "timeout";
  if (lower.includes("block") || lower.includes("denied") || lower === "eacces") return "blocked";
  if (lower.includes("invalid")) return "invalid";
  if (lower.includes("unavailable") || lower.includes("network") || lower.startsWith("econn")) {
    return "unavailable";
  }
  return ERROR_STATES.has(value) ? value : "UNKNOWN";
}

function safeMessage(value) {
  if (typeof value === "string") return value;
  if (typeof value?.message === "string") return value.message;
  if (typeof value?.error === "string") return value.error;
  return "No error details supplied";
}

function readObservedAt(raw) {
  const value = raw?.observed_at ?? raw?.observedAt;
  return typeof value === "string" && value ? value : null;
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("now() must return a valid Date or timestamp");
  return date.toISOString();
}

function safeIsoNow(now) {
  try {
    return isoNow(typeof now === "function" ? now : () => new Date());
  } catch {
    return new Date().toISOString();
  }
}

function serializableTarget(value) {
  if (typeof value === "string") return sanitizeUrlForRecord(value);
  if (value instanceof URL) return sanitizeUrlForRecord(value.href);
  return null;
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return cloneValue(value);
  }
}

function cloneValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object") {
    const copy = {};
    for (const [key, nested] of Object.entries(value)) copy[key] = cloneValue(nested);
    return copy;
  }
  return value;
}
