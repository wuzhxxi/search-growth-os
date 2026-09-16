import { createFinding, evidenceForObservation } from "./evidence.mjs";

export const MAX_ORPHAN_CANDIDATE_FINDINGS = 100;

function outputOf(result) {
  return result?.output && typeof result.output === "object" ? result.output : {};
}

function canonicalText(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function listValue(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined || value === "" ? [] : [value];
}

function containsDirective(values, expected) {
  return values.some((value) =>
    String(value)
      .toLowerCase()
      .split(/[,;\s]+/u)
      .includes(expected),
  );
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function pageEvidence(page, observedAt, note) {
  return evidenceForObservation(
    page.final_url ?? page.url ?? "unknown",
    observedAt,
    note,
  );
}

export function findingsFromHttp(result) {
  if (!result) return [];
  const output = outputOf(result);
  const status = output.http_status ?? output.status ?? output.raw?.http_status;
  const finalUrl = output.final_url ?? output.raw?.final_url ?? output.requested_url;
  const redirectChain = output.redirect_chain ?? output.raw?.redirect_chain ?? [];
  const metaRobots = listValue(output.meta_robots ?? output.parsed?.meta_robots);
  const xRobotsTag = listValue(output.x_robots_tag ?? output.raw?.headers?.["x-robots-tag"]);
  const canonical = canonicalText(output.canonical ?? output.parsed?.canonical);
  const findings = [];

  if (Number.isInteger(status) && (status < 200 || status >= 300)) {
    findings.push(createFinding({
      prefix: "http-status",
      title: `Target returned HTTP ${status}`,
      evidence: evidenceForObservation(finalUrl, result.observed_at, `HTTP response status was ${status}.`),
      businessImpact: "The observed response may prevent normal retrieval of this URL; search visibility or traffic impact is UNKNOWN without additional data.",
      confidence: "high",
      effort: "medium",
      affectedAssets: [finalUrl],
      recommendation: "Confirm that this response is intentional, then restore a successful response or an appropriate redirect where required.",
      validationMethod: "Request the URL again and verify the intended final status and redirect path.",
    }));
  }

  if (redirectChain.length > 1) {
    findings.push(createFinding({
      prefix: "redirect-chain",
      title: "Target uses a multi-hop redirect chain",
      evidence: evidenceForObservation(
        output.requested_url ?? finalUrl,
        result.observed_at,
        `Observed ${redirectChain.length} redirect hops before ${finalUrl}.`,
      ),
      businessImpact: "Additional hops add request latency and failure points; any ranking or conversion impact is UNKNOWN from this audit alone.",
      confidence: "high",
      effort: "low",
      affectedAssets: [output.requested_url ?? finalUrl, finalUrl],
      recommendation: "Where operationally safe, point the initial URL directly to the intended final URL.",
      validationMethod: "Repeat the HTTP check and confirm that the intended redirect path has no unnecessary intermediate hops.",
    }));
  }

  if (containsDirective(metaRobots, "noindex")) {
    findings.push(createFinding({
      prefix: "meta-noindex",
      title: "Target declares meta robots noindex",
      evidence: evidenceForObservation(finalUrl, result.observed_at, `Parsed meta robots value: ${metaRobots.join(", ")}.`),
      businessImpact: "The directive communicates that supporting search engines should not index this page; whether that is intended and its traffic effect are UNKNOWN.",
      confidence: "high",
      effort: "low",
      affectedAssets: [finalUrl],
      recommendation: "Verify the indexing intent. Remove noindex only if the page is meant to be eligible for indexing.",
      validationMethod: "Fetch the page again and inspect the rendered meta robots directives.",
    }));
  }

  if (containsDirective(xRobotsTag, "noindex")) {
    findings.push(createFinding({
      prefix: "x-robots-noindex",
      title: "Target declares X-Robots-Tag noindex",
      evidence: evidenceForObservation(finalUrl, result.observed_at, `Observed X-Robots-Tag value: ${xRobotsTag.join(", ")}.`),
      businessImpact: "The response directive communicates that supporting search engines should not index this resource; whether that is intended and its traffic effect are UNKNOWN.",
      confidence: "high",
      effort: "low",
      affectedAssets: [finalUrl],
      recommendation: "Verify the indexing intent and change the response header only if noindex is unintended.",
      validationMethod: "Request the resource again and inspect the X-Robots-Tag response header.",
    }));
  }

  if (canonical && finalUrl && normalizedUrl(canonical) !== normalizedUrl(finalUrl)) {
    findings.push(createFinding({
      prefix: "canonical-difference",
      title: "Declared canonical differs from the final URL",
      evidence: evidenceForObservation(finalUrl, result.observed_at, `Final URL was ${finalUrl}; parsed canonical was ${canonical}.`),
      businessImpact: "The canonical declaration points consolidation signals elsewhere. Whether this is inconsistent with site intent is UNKNOWN until templates and indexation data are reviewed.",
      confidence: "high",
      effort: "medium",
      affectedAssets: [finalUrl, canonical],
      recommendation: "Confirm the preferred URL and make redirects, internal links, and canonical declarations consistent with that intent.",
      validationMethod: "Re-audit the affected URLs and compare the final URL, canonical, sitemap entry, and internal links.",
    }));
  }

  return findings;
}

function pagesFromCrawler(result) {
  const output = outputOf(result);
  return output.pages ?? output.crawled_pages ?? [];
}

export function findingsFromCrawler(result, { sitemapUrls = [], excludeUrls = [] } = {}) {
  if (!result) return [];
  const pages = pagesFromCrawler(result);
  const findings = [];
  const byRequested = new Map(pages.map((page) => [normalizedUrl(page.url), page]));
  const excluded = new Set(excludeUrls.map(normalizedUrl));

  for (const page of pages) {
    const status = page.http_status ?? page.status;
    const finalUrl = page.final_url ?? page.url;
    const discoveredFrom = page.discovered_from ?? [];
    if (excluded.has(normalizedUrl(page.url)) || excluded.has(normalizedUrl(finalUrl))) continue;

    if (Number.isInteger(status) && (status < 200 || status >= 300)) {
      const isBroken = status >= 400 && discoveredFrom.length > 0;
      findings.push(createFinding({
        prefix: isBroken ? "broken-internal" : "crawl-status",
        title: isBroken ? `Internal URL returned HTTP ${status}` : `Crawled URL returned HTTP ${status}`,
        evidence: pageEvidence(page, result.observed_at, `Crawler observed HTTP ${status}${discoveredFrom.length ? ` after discovery from ${discoveredFrom.join(", ")}` : ""}.`),
        businessImpact: isBroken
          ? "Visitors and crawlers following the observed internal link cannot retrieve a successful response; downstream ranking or traffic impact is UNKNOWN."
          : "The URL was not retrieved with a 2xx response; whether this is intentional and its business impact are UNKNOWN.",
        confidence: "high",
        effort: "medium",
        affectedAssets: [page.url, ...discoveredFrom],
        recommendation: isBroken
          ? "Update the referring internal link, restore the destination, or add an appropriate redirect."
          : "Confirm the intended response and correct the URL or response where necessary.",
        validationMethod: "Repeat the bounded crawl and verify the destination and all referring links.",
      }));
    }

    const redirects = page.redirect_chain ?? page.redirect ?? [];
    if (Array.isArray(redirects) && redirects.length > 1) {
      findings.push(createFinding({
        prefix: "crawl-redirect-chain",
        title: "Crawled URL uses a multi-hop redirect chain",
        evidence: pageEvidence(page, result.observed_at, `Observed ${redirects.length} redirect hops from ${page.url} to ${finalUrl}.`),
        businessImpact: "The extra hops add latency and failure points; ranking and conversion effects are UNKNOWN from crawl evidence alone.",
        confidence: "high",
        effort: "low",
        affectedAssets: [page.url, finalUrl],
        recommendation: "Where safe, link directly to the intended final URL and remove unnecessary intermediate redirects.",
        validationMethod: "Repeat the crawl and confirm the redirect path and internal link target.",
      }));
    }

    const robots = [
      ...listValue(page.meta_robots),
      ...listValue(page.x_robots_tag),
    ];
    if (containsDirective(robots, "noindex")) {
      findings.push(createFinding({
        prefix: "crawl-noindex",
        title: "Crawled page declares noindex",
        evidence: pageEvidence(page, result.observed_at, `Observed robots directive value: ${robots.join(", ")}.`),
        businessImpact: "The directive communicates that supporting search engines should not index this page; its intent and traffic effect are UNKNOWN.",
        confidence: "high",
        effort: "low",
        affectedAssets: [finalUrl],
        recommendation: "Verify the page's intended index eligibility and change the directive only if it is unintended.",
        validationMethod: "Fetch the page again and inspect its meta robots directive.",
      }));
    }

    const canonical = canonicalText(page.canonical);
    if (canonical && finalUrl && normalizedUrl(canonical) !== normalizedUrl(finalUrl)) {
      findings.push(createFinding({
        prefix: "crawl-canonical-difference",
        title: "Crawled page canonical differs from its final URL",
        evidence: pageEvidence(page, result.observed_at, `Final URL was ${finalUrl}; parsed canonical was ${canonical}.`),
        businessImpact: "The declaration points consolidation signals to another URL. Intent and search impact are UNKNOWN without indexation evidence.",
        confidence: "high",
        effort: "medium",
        affectedAssets: [finalUrl, canonical],
        recommendation: "Review canonical intent and align redirects, sitemaps, and internal links where appropriate.",
        validationMethod: "Re-crawl the affected URL and compare canonical, final URL, sitemap membership, and internal links.",
      }));
    }
  }

  const discovered = new Set();
  for (const page of pages) {
    discovered.add(normalizedUrl(page.url));
    discovered.add(normalizedUrl(page.final_url ?? page.url));
    for (const link of page.internal_links ?? []) discovered.add(normalizedUrl(typeof link === "string" ? link : link.url));
  }
  const candidates = [...new Set(sitemapUrls.map(normalizedUrl))]
    .filter((url) => url && !discovered.has(url) && !byRequested.has(url));

  for (const url of candidates.slice(0, MAX_ORPHAN_CANDIDATE_FINDINGS)) {
    findings.push(createFinding({
      prefix: "orphan-candidate",
      title: "Sitemap URL is an orphan candidate in the bounded crawl",
      evidence: evidenceForObservation(
        url,
        result.observed_at,
        "The URL appeared in collected sitemap data but was not observed in the bounded internal-link crawl. This does not prove that the URL has no links outside the collected scope.",
        "INFERRED",
      ),
      businessImpact: "Internal discoverability may be weaker than intended, but absolute orphan status and search impact are UNKNOWN outside the collected crawl scope.",
      confidence: "low",
      effort: "medium",
      affectedAssets: [url],
      recommendation: "Check broader crawl, navigation, template, and log data before deciding whether to add an internal link or remove the sitemap entry.",
      validationMethod: "Run a larger bounded crawl and inspect server logs or a complete internal-link export for references to this URL.",
    }));
  }

  if (candidates.length > MAX_ORPHAN_CANDIDATE_FINDINGS) {
    const omitted = candidates.length - MAX_ORPHAN_CANDIDATE_FINDINGS;
    findings.push(createFinding({
      prefix: "orphan-candidate-summary",
      title: "Additional sitemap orphan candidates were omitted by the output limit",
      evidence: evidenceForObservation(
        candidates[MAX_ORPHAN_CANDIDATE_FINDINGS],
        result.observed_at,
        `${omitted} additional sitemap URLs were outside the bounded crawl discovery set; individual findings were not emitted to keep the Audit Run bounded.`,
        "INFERRED",
      ),
      businessImpact: "These remain scoped candidates only; absolute orphan status and business impact are UNKNOWN.",
      confidence: "low",
      effort: "medium",
      affectedAssets: [candidates[MAX_ORPHAN_CANDIDATE_FINDINGS]],
      recommendation: "Review the complete structured sitemap URL set with broader crawl or log evidence before taking action.",
      validationMethod: "Use a larger bounded crawl or a complete internal-link export, then validate a sampled and prioritized subset.",
    }));
  }

  return dedupeFindings(findings);
}

export function findingsFromSitemaps(result) {
  if (!result) return [];
  const output = outputOf(result);
  const sitemaps = output.sitemaps ?? output.results ?? [];
  const findings = [];
  for (const sitemap of sitemaps) {
    const errors = sitemap.parse_errors ?? [];
    if (errors.length === 0) continue;
    findings.push(createFinding({
      prefix: "sitemap-parse",
      title: "Sitemap could not be fully parsed",
      evidence: evidenceForObservation(
        sitemap.sitemap_url ?? sitemap.url,
        result.observed_at,
        `Parser reported: ${errors.map((error) => typeof error === "string" ? error : error.message).join("; ")}.`,
      ),
      businessImpact: "Some submitted URLs may not be represented in the collected sitemap evidence; indexing or traffic impact is UNKNOWN.",
      confidence: "high",
      effort: "medium",
      affectedAssets: [sitemap.sitemap_url ?? sitemap.url],
      recommendation: "Correct the XML or response and ensure the sitemap follows the intended sitemap protocol.",
      validationMethod: "Fetch and parse the sitemap again, then verify its declared child sitemaps or URLs.",
    }));
  }
  return findings;
}

export function findingsFromRobots(result) {
  if (!result) return [];
  const output = outputOf(result);
  const blocked = (output.evaluations ?? []).filter(
    (evaluation) => evaluation?.allowed === false,
  );
  if (blocked.length === 0) return [];
  const target = result.input?.target_url ?? output.robots_url ?? "unknown";
  const labels = blocked.map((evaluation) => {
    const applicability = evaluation.robots_policy_applicability;
    return `${evaluation.crawler}${applicability && applicability !== "applies" ? ` (${applicability})` : ""}`;
  });
  return [createFinding({
    prefix: "robots-disallow",
    title: "Target path is disallowed for configured crawler tokens",
    evidence: evidenceForObservation(
      output.robots_url ?? target,
      result.observed_at,
      `Parsed robots.txt rules evaluated the target path as disallowed for: ${labels.join(", ")}.`,
    ),
    businessImpact: "The observed rules may restrict requests by the named crawlers. They do not by themselves prove indexing, ranking, answer inclusion, citation, or traffic impact.",
    confidence: "medium",
    effort: "low",
    affectedAssets: [target, output.robots_url].filter(Boolean),
    recommendation: "Confirm that each restriction is intentional and recheck the crawler's current official documentation before changing robots.txt.",
    validationMethod: "Fetch robots.txt again, evaluate the same path and product tokens, and confirm current behavior against official crawler documentation and server logs where available.",
  })];
}

export function dedupeFindings(findings) {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
