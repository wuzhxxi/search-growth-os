import {createHash} from "node:crypto";
import {
  sanitizeRecord,
  sanitizeUrlForRecord,
} from "../security/record-sanitizer.mjs";
import {inspectRobots} from "../robots/robots-adapter.mjs";
import {
  DEFAULT_MAX_SITEMAP_BODY_BYTES,
  DEFAULT_SAMPLE_URLS,
  MAX_SITEMAP_URL_BYTES,
  parseSitemapXml,
} from "./sitemap-parser.mjs";

const VERSION = "0.2.0";
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_SITEMAPS = 50;
const DEFAULT_MAX_URLS = 50_000;
const MAX_DEPTH = 5;
const MAX_SITEMAPS = 100;
const MAX_URLS = 100_000;
const MAX_SAMPLE_URLS = 100;
const MAX_AGGREGATE_URL_BYTES = 16 * 1024 * 1024;

export const SITEMAP_LIMITS = Object.freeze({
  max_depth: MAX_DEPTH,
  max_sitemaps: MAX_SITEMAPS,
  max_urls: MAX_URLS,
  max_body_bytes: DEFAULT_MAX_SITEMAP_BODY_BYTES,
  max_sample_urls: MAX_SAMPLE_URLS,
  max_url_bytes: MAX_SITEMAP_URL_BYTES,
  max_aggregate_url_bytes: MAX_AGGREGATE_URL_BYTES,
});

async function defaultHttpAdapter(input) {
  const {inspectHttp} = await import("../http/http-adapter.mjs");
  return inspectHttp(input);
}

function isoTimestamp(now) {
  const value = typeof now === "function" ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function resultError(code, message, details = null) {
  return {code, message, details};
}

function adapterResult({input, output, evidence, observedAt, status, errors}) {
  return sanitizeRecord({
    id: SITEMAP_ADAPTER.id,
    name: SITEMAP_ADAPTER.name,
    version: SITEMAP_ADAPTER.version,
    capabilities: [...SITEMAP_ADAPTER.capabilities],
    input,
    output,
    evidence,
    observed_at: observedAt,
    status,
    errors,
  });
}

function emptyOutput(limits) {
  return {
    discovery: {
      robots_status: "not_attempted",
      robots_url: null,
      robots_http_status: null,
      robots_sitemaps: [],
      default_sitemap: null,
    },
    limits,
    sitemaps: [],
    urls: [],
    raw: [],
    summary: {
      sitemaps_checked: 0,
      urls_discovered: 0,
      cycles_skipped: 0,
      depth_limits_hit: 0,
      sitemap_limit_hit: false,
      url_limit_hit: false,
      aggregate_url_byte_limit_hit: false,
      aggregate_url_bytes: 0,
      rate_limited: false,
    },
  };
}

function responseOutput(result) {
  return result?.output && typeof result.output === "object" ? result.output : {};
}

function responseBody(result) {
  const output = responseOutput(result);
  const candidates = [
    output.raw?.body,
    output.raw?.body_text,
    output.body,
    output.body_text,
    output.raw_body,
  ];
  return candidates.find((candidate) => typeof candidate === "string") ?? null;
}

function responseStatusCode(result) {
  const output = responseOutput(result);
  const value =
    output.http_status ?? output.status_code ?? output.raw?.http_status ?? output.raw?.status;
  return Number.isInteger(value) ? value : null;
}

function transportStatus(result) {
  const allowed = new Set([
    "ok",
    "partial",
    "UNKNOWN",
    "unavailable",
    "timeout",
    "blocked",
    "invalid",
  ]);
  return allowed.has(result?.status) ? result.status : "UNKNOWN";
}

function errorStatusForHttp(httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return "blocked";
  if (httpStatus === 408 || httpStatus === 504) return "timeout";
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) return "unavailable";
  return null;
}

function clientFromDependencies(dependencies) {
  if (typeof dependencies.requestUrl === "function") {
    return (input) => {
      const {url, ...config} = input;
      return dependencies.requestUrl(url, config, dependencies);
    };
  }
  if (dependencies.httpAdapter && typeof dependencies.httpAdapter.inspect === "function") {
    return (input) => dependencies.httpAdapter.inspect(input);
  }
  if (typeof dependencies.httpAdapter === "function") return dependencies.httpAdapter;
  if (typeof dependencies.inspectHttp === "function") return dependencies.inspectHttp;
  return defaultHttpAdapter;
}

function appendHttpErrors(errors, result, url) {
  if (!Array.isArray(result?.errors)) return;
  const allowed = ["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"];
  for (const error of result.errors) {
    const code = allowed.includes(error?.code)
      ? error.code
      : allowed.includes(error?.status)
        ? error.status
        : allowed.includes(result?.status)
          ? result.status
      : "UNKNOWN";
    errors.push(
      resultError(code, String(error?.message ?? "HTTP inspection failed"), {
        url,
        kind: allowed.includes(error?.code) ? null : String(error?.code ?? "UNKNOWN"),
        upstream: error?.details && typeof error.details === "object" ? error.details : null,
      }),
    );
  }
}

function normalizeConfig(config) {
  const outer = config && typeof config === "object" ? config : {};
  const nested = outer.configuration && typeof outer.configuration === "object"
    ? outer.configuration
    : {};
  return {
    ...outer,
    robotsResult: outer.robotsResult ?? outer.robots_result,
    robotsSitemaps: outer.robotsSitemaps ?? outer.robots_sitemaps,
    discoverRobots: outer.discoverRobots ?? outer.discover_robots,
    includeDefault: outer.includeDefault ?? outer.include_default,
    maxDepth:
      outer.maxDepth ??
      outer.max_depth ??
      outer.max_sitemap_depth ??
      nested.max_sitemap_depth,
    maxSitemaps:
      outer.maxSitemaps ?? outer.max_sitemaps ?? nested.max_sitemaps,
    maxUrls:
      outer.maxUrls ??
      outer.max_urls ??
      outer.max_sitemap_urls ??
      nested.max_sitemap_urls,
    maxBodyBytes:
      outer.maxBodyBytes ?? outer.max_body_bytes ?? nested.max_body_bytes,
    maxRobotsBodyBytes:
      outer.maxRobotsBodyBytes ??
      outer.max_robots_body_bytes ??
      nested.max_body_bytes,
    sampleLimit: outer.sampleLimit ?? outer.sample_limit,
    timeoutMs: outer.timeoutMs ?? outer.timeout_ms ?? nested.timeout_ms,
    maxRedirects:
      outer.maxRedirects ?? outer.max_redirects ?? nested.max_redirects,
    requestBudget: outer.requestBudget ?? outer.request_budget,
  };
}

function normalizedUrl(value, base) {
  try {
    if (Buffer.byteLength(String(value)) > MAX_SITEMAP_URL_BYTES) return null;
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    if (Buffer.byteLength(url.href) > MAX_SITEMAP_URL_BYTES) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sitemapReport(item, overrides = {}) {
  return {
    url: item.url,
    final_url: null,
    parent_url: item.parent_url,
    depth: item.depth,
    status: "UNKNOWN",
    http_status: null,
    type: "unknown",
    url_count: 0,
    child_sitemap_count: 0,
    parse_errors: [],
    sample_urls: [],
    body_bytes: null,
    body_sha256: null,
    ...overrides,
  };
}

function chooseOverallStatus(reports, errors) {
  const successful = reports.some(({status}) => status === "ok" || status === "partial");
  if (successful) return errors.length || reports.some(({status}) => status !== "ok") ? "partial" : "ok";
  const statuses = reports.map(({status}) => status);
  for (const candidate of ["invalid", "blocked", "timeout", "unavailable", "UNKNOWN"]) {
    if (statuses.includes(candidate) || errors.some(({code}) => code === candidate)) return candidate;
  }
  return "unavailable";
}

function validateLimits(limits) {
  if (!Number.isSafeInteger(limits.max_depth) || limits.max_depth < 0 || limits.max_depth > MAX_DEPTH) {
    return `maxDepth must be an integer between 0 and ${MAX_DEPTH}`;
  }
  if (!Number.isSafeInteger(limits.max_sitemaps) || limits.max_sitemaps < 1 || limits.max_sitemaps > MAX_SITEMAPS) {
    return `maxSitemaps must be an integer between 1 and ${MAX_SITEMAPS}`;
  }
  if (!Number.isSafeInteger(limits.max_urls) || limits.max_urls < 0 || limits.max_urls > MAX_URLS) {
    return `maxUrls must be an integer between 0 and ${MAX_URLS}`;
  }
  if (
    !Number.isSafeInteger(limits.max_body_bytes) ||
    limits.max_body_bytes < 1 ||
    limits.max_body_bytes > DEFAULT_MAX_SITEMAP_BODY_BYTES
  ) {
    return `maxBodyBytes must be an integer between 1 and ${DEFAULT_MAX_SITEMAP_BODY_BYTES}`;
  }
  if (!Number.isSafeInteger(limits.sample_urls) || limits.sample_urls < 0 || limits.sample_urls > MAX_SAMPLE_URLS) {
    return `sampleLimit must be an integer between 0 and ${MAX_SAMPLE_URLS}`;
  }
  return null;
}

function boundedDeclarations(values, errors) {
  const retained = [];
  const recorded = [];
  const inspectionLimit = Math.min(values.length, MAX_SITEMAPS);
  for (let index = 0; index < inspectionLimit; index += 1) {
    const raw = values[index];
    if (typeof raw !== "string" && !(raw instanceof URL)) {
      errors.push(
        resultError("invalid", "Sitemap declaration must be a URL string", {
          kind: "SITEMAP_DECLARATION_INVALID",
          declaration_index: index,
        }),
      );
      continue;
    }
    const value = String(raw);
    if (Buffer.byteLength(value) > MAX_SITEMAP_URL_BYTES) {
      errors.push(
        resultError("invalid", "Sitemap declaration exceeds the URL length limit", {
          kind: "SITEMAP_DECLARATION_TOO_LONG",
          declaration_index: index,
          max_url_bytes: MAX_SITEMAP_URL_BYTES,
        }),
      );
      continue;
    }
    retained.push(value);
    recorded.push(sanitizeUrlForRecord(value));
  }
  if (values.length > MAX_SITEMAPS) {
    errors.push(
      resultError("unavailable", "Sitemap declarations reached the hard collection limit", {
        kind: "SITEMAP_DECLARATION_LIMIT",
        supplied: values.length,
        retained: retained.length,
        max_declarations: MAX_SITEMAPS,
      }),
    );
  }
  return {retained, recorded};
}

async function discoverFromRobots(targetUrl, config, dependencies, output, evidence, errors) {
  if (Array.isArray(config.robotsSitemaps)) {
    const declarations = boundedDeclarations(config.robotsSitemaps, errors);
    output.discovery.robots_status = "provided";
    output.discovery.robots_sitemaps = declarations.recorded;
    return declarations.retained;
  }
  if (Array.isArray(dependencies.robotsSitemaps)) {
    const declarations = boundedDeclarations(dependencies.robotsSitemaps, errors);
    output.discovery.robots_status = "provided";
    output.discovery.robots_sitemaps = declarations.recorded;
    return declarations.retained;
  }
  if (config.discoverRobots === false) return [];

  const robotsResult = config.robotsResult ?? dependencies.robotsResult ??
    (await inspectRobots(
      targetUrl,
      {
        timeoutMs: config.timeoutMs,
        maxBodyBytes: config.maxRobotsBodyBytes,
        maxRedirects: config.maxRedirects,
        requestBudget: config.requestBudget,
        crawlers: [],
      },
      dependencies,
    ));
  output.discovery.robots_status = robotsResult.status;
  output.discovery.robots_url = robotsResult.output?.robots_url ?? null;
  output.discovery.robots_http_status = responseStatusCode(robotsResult);
  const declarations = boundedDeclarations(
    Array.isArray(robotsResult.output?.policy?.sitemaps)
      ? robotsResult.output.policy.sitemaps
      : Array.isArray(robotsResult.output?.sitemaps)
        ? robotsResult.output.sitemaps
        : [],
    errors,
  );
  output.discovery.robots_sitemaps = declarations.recorded;
  if (Array.isArray(robotsResult.evidence)) evidence.push(...robotsResult.evidence);
  if (robotsResult.status !== "ok") {
    const discoveryStatus = ["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"]
      .includes(robotsResult.status)
      ? robotsResult.status
      : "unavailable";
    errors.push(
      resultError(discoveryStatus, "robots.txt sitemap discovery did not complete fully", {
        robots_url: output.discovery.robots_url,
        upstream_status: robotsResult.status,
      }),
    );
  }
  if (output.discovery.robots_http_status === 429) {
    output.summary.rate_limited = true;
    errors.push(
      resultError(
        "unavailable",
        "robots.txt returned HTTP 429; sitemap requests were not started",
        {
          kind: "HTTP_RATE_LIMITED",
          url: output.discovery.robots_url,
          http_status: 429,
        },
      ),
    );
  }
  return declarations.retained;
}

async function runSitemapInspection(targetUrl, config, dependencies) {
  config = normalizeConfig(config);
  const observedAt = isoTimestamp(dependencies.now);
  const limits = {
    max_depth: config.maxDepth ?? DEFAULT_MAX_DEPTH,
    max_sitemaps: config.maxSitemaps ?? DEFAULT_MAX_SITEMAPS,
    max_urls: config.maxUrls ?? DEFAULT_MAX_URLS,
    max_body_bytes: config.maxBodyBytes ?? DEFAULT_MAX_SITEMAP_BODY_BYTES,
    sample_urls: config.sampleLimit ?? DEFAULT_SAMPLE_URLS,
    max_aggregate_url_bytes: MAX_AGGREGATE_URL_BYTES,
  };
  const input = {
    target_url: sanitizeUrlForRecord(targetUrl ?? ""),
    discover_robots: config.discoverRobots !== false,
    include_default: config.includeDefault !== false,
    ...limits,
  };
  const output = emptyOutput(limits);
  const evidence = [];
  const errors = [];

  let target;
  try {
    if (Buffer.byteLength(String(targetUrl ?? "")) > MAX_SITEMAP_URL_BYTES) {
      throw new TypeError(`Target URL exceeds ${MAX_SITEMAP_URL_BYTES} bytes`);
    }
    target = new URL(targetUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new TypeError("Only http and https targets are supported");
    }
    if (target.username || target.password) {
      throw new TypeError("Target URLs must not contain credentials");
    }
    if (Buffer.byteLength(target.href) > MAX_SITEMAP_URL_BYTES) {
      throw new TypeError(`Normalized target URL exceeds ${MAX_SITEMAP_URL_BYTES} bytes`);
    }
  } catch (error) {
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "invalid",
      errors: [resultError("invalid", error.message, {target_url: input.target_url})],
    });
  }

  const limitError = validateLimits(limits);
  if (limitError) {
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "invalid",
      errors: [resultError("invalid", limitError)],
    });
  }

  const declared = await discoverFromRobots(
    target.href,
    config,
    dependencies,
    output,
    evidence,
    errors,
  );
  if (output.summary.rate_limited) {
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "unavailable",
      errors,
    });
  }
  const defaultSitemap = new URL("/sitemap.xml", target.origin).href;
  output.discovery.default_sitemap = config.includeDefault === false ? null : defaultSitemap;
  const candidates = [
    ...declared,
    ...(config.includeDefault === false ? [] : [defaultSitemap]),
  ];

  const queue = [];
  const scheduled = new Set();
  for (const candidate of candidates) {
    const url = normalizedUrl(candidate, target.origin);
    if (!url) {
      errors.push(
        resultError("invalid", "Sitemap declaration is not an http or https URL", {
          declaration: sanitizeUrlForRecord(String(candidate)),
          kind: "SITEMAP_DECLARATION_INVALID",
        }),
      );
      continue;
    }
    if (new URL(url).origin !== target.origin) {
      errors.push(
        resultError("blocked", "Cross-origin sitemap declaration is outside audit scope", {
          declaration: url,
          kind: "SITEMAP_CROSS_ORIGIN_BLOCKED",
        }),
      );
      continue;
    }
    if (scheduled.has(url)) continue;
    scheduled.add(url);
    queue.push({url, parent_url: null, depth: 0, ancestors: new Set()});
  }

  const client = clientFromDependencies(dependencies);
  const visited = new Set();
  let totalUrls = 0;
  let totalUrlBytes = 0;
  let aggregateUrlLimitHit = false;
  let fetched = 0;

  while (queue.length) {
    if (fetched >= limits.max_sitemaps) {
      output.summary.sitemap_limit_hit = true;
      errors.push(
        resultError("unavailable", "Sitemap traversal reached maxSitemaps", {
          kind: "SITEMAP_LIMIT_REACHED",
          max_sitemaps: limits.max_sitemaps,
          remaining_queue: queue.length,
        }),
      );
      break;
    }

    const item = queue.shift();
    if (item.depth > limits.max_depth) {
      output.summary.depth_limits_hit += 1;
      errors.push(
        resultError("unavailable", "Nested sitemap exceeds maxDepth", {
          kind: "SITEMAP_DEPTH_LIMIT",
          url: item.url,
          depth: item.depth,
          max_depth: limits.max_depth,
        }),
      );
      continue;
    }
    if (visited.has(item.url)) continue;
    visited.add(item.url);
    fetched += 1;

    let httpResult;
    try {
      httpResult = await client({
        url: item.url,
        timeout_ms: config.timeoutMs,
        max_body_bytes: limits.max_body_bytes,
        max_redirects: config.maxRedirects,
        audit_budget: config.requestBudget,
        same_origin_only: true,
        allowed_origin: target.origin,
      });
    } catch (error) {
      const status = ["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"].includes(
        error?.status,
      )
        ? error.status
        : error?.name === "AbortError"
          ? "timeout"
          : "unavailable";
      output.sitemaps.push(sitemapReport(item, {status}));
      errors.push(resultError(status, error.message, {url: item.url, kind: error?.code ?? null}));
      continue;
    }

    const httpOutput = responseOutput(httpResult);
    const httpStatus = responseStatusCode(httpResult);
    const body = responseBody(httpResult);
    const finalUrl = httpOutput.final_url ?? item.url;
    const bodyBytes = body === null ? null : Buffer.byteLength(body);
    const raw = {
      requested_url: httpOutput.requested_url ?? item.url,
      final_url: finalUrl,
      http_status: httpStatus,
      content_type: httpOutput.content_type ?? httpOutput.headers?.["content-type"] ?? null,
      body_bytes: bodyBytes,
      body_sha256:
        body === null ? null : createHash("sha256").update(body).digest("hex"),
    };
    output.raw.push(raw);
    if (Array.isArray(httpResult?.evidence)) evidence.push(...httpResult.evidence);
    else if (httpStatus !== null) {
      evidence.push({
        state: "OBSERVED",
        source: finalUrl,
        observed_at: observedAt,
        notes: `Sitemap returned HTTP ${httpStatus}`,
      });
    }

    const upstreamStatus = transportStatus(httpResult);
    if (!["ok", "partial"].includes(upstreamStatus)) {
      output.sitemaps.push(
        sitemapReport(item, {
          final_url: finalUrl,
          status: upstreamStatus,
          http_status: httpStatus,
          body_bytes: bodyBytes,
          body_sha256: raw.body_sha256,
        }),
      );
      appendHttpErrors(errors, httpResult, item.url);
      if (!Array.isArray(httpResult?.errors) || httpResult.errors.length === 0) {
        errors.push(
          resultError(upstreamStatus, "Sitemap HTTP inspection did not complete", {
            url: item.url,
          }),
        );
      }
      continue;
    }

    if (upstreamStatus === "partial") {
      output.sitemaps.push(
        sitemapReport(item, {
          final_url: finalUrl,
          status: "unavailable",
          http_status: httpStatus,
          body_bytes: bodyBytes,
          body_sha256: raw.body_sha256,
        }),
      );
      appendHttpErrors(errors, httpResult, item.url);
      errors.push(
        resultError(
          "unavailable",
          "Sitemap response bytes were not reliable enough to parse safely",
          {url: item.url, kind: "SITEMAP_HTTP_PARTIAL"},
        ),
      );
      continue;
    }

    const httpErrorStatus = errorStatusForHttp(httpStatus);
    if (httpErrorStatus) {
      output.sitemaps.push(
        sitemapReport(item, {
          final_url: finalUrl,
          status: httpErrorStatus,
          http_status: httpStatus,
          body_bytes: bodyBytes,
          body_sha256: raw.body_sha256,
        }),
      );
      errors.push(
        resultError(httpErrorStatus, `Sitemap returned HTTP ${httpStatus}`, {
          url: item.url,
          http_status: httpStatus,
          ...(httpStatus === 429
            ? {kind: "HTTP_RATE_LIMITED", remaining_queue: queue.length}
            : {}),
        }),
      );
      if (httpStatus === 429) {
        output.summary.rate_limited = true;
        break;
      }
      continue;
    }
    if (body === null) {
      output.sitemaps.push(
        sitemapReport(item, {
          final_url: finalUrl,
          status: "unavailable",
          http_status: httpStatus,
        }),
      );
      errors.push(
        resultError("unavailable", "Sitemap response body is unavailable", {url: item.url}),
      );
      continue;
    }

    const parsed = parseSitemapXml(body, {
      maxBodyBytes: limits.max_body_bytes,
      maxUrls: Math.max(0, limits.max_urls - totalUrls),
      maxSitemaps: Math.max(0, limits.max_sitemaps - fetched),
      sampleLimit: limits.sample_urls,
    });
    const acceptedUrls = [];
    for (const url of parsed.urls) {
      const urlBytes = Buffer.byteLength(url);
      if (totalUrlBytes + urlBytes > MAX_AGGREGATE_URL_BYTES) {
        aggregateUrlLimitHit = true;
        output.summary.url_limit_hit = true;
        output.summary.aggregate_url_byte_limit_hit = true;
        errors.push(
          resultError("unavailable", "Aggregate sitemap URL byte limit reached", {
            kind: "SITEMAP_AGGREGATE_URL_BYTES_LIMIT",
            max_aggregate_url_bytes: MAX_AGGREGATE_URL_BYTES,
          }),
        );
        break;
      }
      acceptedUrls.push(url);
      totalUrlBytes += urlBytes;
    }
    totalUrls += acceptedUrls.length;
    output.urls.push(...acceptedUrls);
    const report = sitemapReport(item, {
      final_url: finalUrl,
      status: aggregateUrlLimitHit && parsed.status === "ok" ? "partial" : parsed.status,
      http_status: httpStatus,
      type: parsed.type,
      url_count: parsed.url_count,
      child_sitemap_count: parsed.child_sitemap_count,
      parse_errors: parsed.parse_errors,
      sample_urls:
        parsed.type === "urlset"
          ? acceptedUrls.slice(0, limits.sample_urls)
          : parsed.sample_urls,
      body_bytes: bodyBytes,
      body_sha256: raw.body_sha256,
    });
    output.sitemaps.push(report);

    if (parsed.parse_errors.length) {
      const limitHit = parsed.parse_errors.some(({code}) => code === "SITEMAP_ENTRY_LIMIT");
      if (limitHit && parsed.type === "urlset") output.summary.url_limit_hit = true;
      if (limitHit && parsed.type === "sitemapindex") output.summary.sitemap_limit_hit = true;
      errors.push(
        resultError("invalid", "Sitemap contains parse or limit errors", {
          url: item.url,
          parse_error_count: parsed.parse_errors.length,
        }),
      );
    }

    if (aggregateUrlLimitHit) break;
    if (parsed.type !== "sitemapindex") continue;
    const childAncestors = new Set(item.ancestors);
    childAncestors.add(item.url);
    for (const child of parsed.child_sitemaps) {
      const childUrl = normalizedUrl(child, finalUrl);
      if (!childUrl) continue;
      if (new URL(childUrl).origin !== target.origin) {
        errors.push(
          resultError("blocked", "Cross-origin child sitemap is outside audit scope", {
            kind: "SITEMAP_CROSS_ORIGIN_BLOCKED",
            url: childUrl,
            parent_url: item.url,
          }),
        );
        continue;
      }
      if (childAncestors.has(childUrl)) {
        output.summary.cycles_skipped += 1;
        errors.push(
          resultError("invalid", "Sitemap cycle detected", {
            kind: "SITEMAP_CYCLE",
            url: childUrl,
            parent_url: item.url,
          }),
        );
        continue;
      }
      if (scheduled.has(childUrl)) continue;
      scheduled.add(childUrl);
      queue.push({
        url: childUrl,
        parent_url: item.url,
        depth: item.depth + 1,
        ancestors: childAncestors,
      });
    }
  }

  output.summary.sitemaps_checked = fetched;
  output.summary.urls_discovered = totalUrls;
  output.summary.aggregate_url_bytes = totalUrlBytes;
  const status = chooseOverallStatus(output.sitemaps, errors);
  return adapterResult({input, output, evidence, observedAt, status, errors});
}

export async function inspectSitemaps(targetUrl, config = {}, dependencies = {}) {
  return runSitemapInspection(targetUrl, config, dependencies);
}

export function createSitemapAdapter(defaultDependencies = {}) {
  return Object.freeze({
    ...SITEMAP_METADATA,
    inspect(targetUrl, config = {}, dependencies = {}) {
      return runSitemapInspection(targetUrl, config, {
        ...defaultDependencies,
        ...dependencies,
      });
    },
  });
}

const SITEMAP_METADATA = Object.freeze({
  id: "sitemap",
  name: "Sitemap adapter",
  version: VERSION,
  capabilities: Object.freeze([
    "sitemap.discovery",
    "sitemap.fetch",
    "sitemap.parse",
    "sitemap.traverse",
  ]),
});

export const SITEMAP_ADAPTER = Object.freeze({
  ...SITEMAP_METADATA,
  inspect: inspectSitemaps,
});

export {DEFAULT_MAX_DEPTH, DEFAULT_MAX_SITEMAPS, DEFAULT_MAX_URLS};
