import { randomUUID } from "node:crypto";
import {
  AUDIT_REQUEST_BUDGET_LIMITS,
  createRequestBudget,
  requestBudgetSnapshot,
} from "../core/request-budget.mjs";
import {sanitizeRecord} from "../security/record-sanitizer.mjs";

import {
  dedupeFindings,
  findingsFromCrawler,
  findingsFromHttp,
  findingsFromRobots,
  findingsFromSitemaps,
} from "./findings.mjs";

export const AUDIT_KINDS = Object.freeze(["technical", "robots", "sitemap", "crawl"]);
export const MAX_AUDIT_FINDINGS = 500;

export const DEFAULT_AUDIT_CONFIGURATION = Object.freeze({
  max_pages: 50,
  concurrency: 2,
  timeout_ms: 10_000,
  max_redirects: 5,
  max_body_bytes: 2_000_000,
  max_sitemaps: 25,
  max_sitemap_depth: 3,
  max_sitemap_urls: 50_000,
  max_links_per_page: 500,
  max_total_requests: AUDIT_REQUEST_BUDGET_LIMITS.max_requests,
  max_total_response_bytes: AUDIT_REQUEST_BUDGET_LIMITS.max_response_bytes,
  max_run_time_ms: AUDIT_REQUEST_BUDGET_LIMITS.max_duration_ms,
  same_origin_only: true,
  respect_robots: true,
  user_agent: "SearchGrowthOS/0.2.0 (+https://github.com/wuzhxxi/search-growth-os; technical-audit)",
});

const FAILURE_STATUSES = new Set([
  "UNKNOWN",
  "unavailable",
  "timeout",
  "blocked",
  "invalid",
]);

function isoNow(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

function resultStatus(result) {
  return typeof result?.status === "string" ? result.status : "UNKNOWN";
}

function isUsable(result) {
  return resultStatus(result) === "ok" || resultStatus(result) === "partial";
}

function responseHttpStatus(result) {
  const output = result?.output && typeof result.output === "object" ? result.output : {};
  const value = output.http_status ?? output.status_code ?? output.raw?.http_status;
  return Number.isInteger(value) ? value : null;
}

function isRateLimited(result) {
  return responseHttpStatus(result) === 429;
}

function normalizedErrors(results, runnerErrors = []) {
  const errors = [...runnerErrors];
  for (const result of results) {
    for (const error of Array.isArray(result?.errors) ? result.errors : []) {
      errors.push({
        code: String(error.status ?? error.code ?? resultStatus(result)),
        message: String(error.message ?? "Adapter returned an error without details"),
        adapter: result.id ?? null,
      });
    }
  }
  return errors;
}

function normalizedEvidence(results) {
  const evidence = [];
  for (const result of results) {
    for (const item of Array.isArray(result?.evidence) ? result.evidence : []) {
      if (!item || typeof item !== "object") continue;
      evidence.push({
        state: item.state ?? (isUsable(result) ? "OBSERVED" : "UNKNOWN"),
        source: String(item.source ?? result.id ?? "unknown"),
        observed_at: Object.hasOwn(item, "observed_at")
          ? item.observed_at
          : result.observed_at ?? null,
        notes: String(item.notes ?? ""),
      });
    }
  }
  return evidence;
}

function sitemapUrls(result) {
  const output = result?.output ?? {};
  const candidates = [
    ...(Array.isArray(output.urls) ? output.urls : []),
    ...(Array.isArray(output.discovered_urls) ? output.discovered_urls : []),
  ];
  for (const sitemap of output.sitemaps ?? output.results ?? []) {
    candidates.push(...(sitemap.urls ?? []));
    candidates.push(...(sitemap.sample_urls ?? []));
  }
  return [...new Set(candidates.filter((value) => typeof value === "string"))];
}

function crawlPageCount(result) {
  const output = result?.output ?? {};
  return (output.pages ?? output.crawled_pages ?? []).length;
}

function sitemapCount(result) {
  const output = result?.output ?? {};
  return (output.sitemaps ?? output.results ?? []).length;
}

function overallStatus(results, errors, kind) {
  if (results.length === 0) return errors.length ? "UNKNOWN" : "UNKNOWN";
  if (kind !== "technical") {
    const expectedIds = {
      robots: new Set(["robots"]),
      sitemap: new Set(["sitemap"]),
      crawl: new Set(["bounded-technical-crawler", "crawler"]),
    }[kind];
    const primary = [...results].reverse().find((result) => expectedIds?.has(result?.id));
    if (!primary) {
      const primaryError = [...errors].reverse().find(
        (error) => error.adapter === (kind === "crawl" ? "crawler" : kind),
      );
      if (primaryError && FAILURE_STATUSES.has(primaryError.code)) return primaryError.code;
      return "UNKNOWN";
    }
    const primaryStatus = resultStatus(primary);
    if (FAILURE_STATUSES.has(primaryStatus)) return primaryStatus;
  }
  const statuses = results.map(resultStatus);
  const usableCount = statuses.filter((status) => status === "ok" || status === "partial").length;
  if (usableCount > 0 && (errors.length > 0 || statuses.some((status) => status !== "ok"))) {
    return "partial";
  }
  if (usableCount > 0) return "ok";
  return statuses.find((status) => FAILURE_STATUSES.has(status)) ?? "UNKNOWN";
}

async function invoke(label, adapter, target, context, runnerErrors) {
  if (typeof adapter !== "function") {
    runnerErrors.push({
      code: "unavailable",
      message: `${label} adapter is unavailable`,
      adapter: label,
    });
    return null;
  }
  try {
    return await adapter(target, context);
  } catch (error) {
    runnerErrors.push({
      code: String(error?.status ?? error?.code ?? "UNKNOWN"),
      message: String(error?.message ?? `${label} adapter failed`),
      adapter: label,
    });
    return null;
  }
}

export function createAuditRunner({
  http,
  robots,
  sitemap,
  crawler,
  clock = () => new Date(),
  createRunId = randomUUID,
} = {}) {
  return async function runAudit(kind, target, configuration = {}) {
    if (!AUDIT_KINDS.includes(kind)) throw new TypeError(`Unsupported audit kind: ${kind}`);
    if (typeof target !== "string" || !target.trim()) throw new TypeError("Target URL is required");

    const timestamp = isoNow(clock);
    const config = { ...DEFAULT_AUDIT_CONFIGURATION, ...configuration };
    const requestBudget = createRequestBudget({
      maxRequests: config.max_total_requests,
      maxResponseBytes: config.max_total_response_bytes,
      maxDurationMs: config.max_run_time_ms,
    });
    const baseContext = {configuration: config, timestamp, request_budget: requestBudget};
    const results = [];
    const runnerErrors = [];
    let httpResult = null;
    let robotsResult = null;
    let sitemapResult = null;
    let crawlerResult = null;

    if (kind === "technical") {
      httpResult = await invoke("http", http, target, baseContext, runnerErrors);
      if (httpResult) results.push(httpResult);
      if (httpResult && (isRateLimited(httpResult) || !isUsable(httpResult))) {
        if (isRateLimited(httpResult)) {
          runnerErrors.push({
            code: "HTTP_RATE_LIMITED",
            message: "Target returned HTTP 429; remaining audit requests were not started",
            adapter: "http",
          });
        }
        const evidence = normalizedEvidence(results);
        const errors = normalizedErrors(results, runnerErrors);
        return buildRun({
          kind,
          target,
          timestamp,
          config,
          results,
          evidence,
          findings: findingsFromHttp(httpResult),
          errors,
          createRunId,
          requestBudget,
        });
      }
    }

    if (["technical", "robots", "sitemap", "crawl"].includes(kind)) {
      robotsResult = await invoke(
        "robots",
        robots,
        target,
        { ...baseContext, http_result: httpResult },
        runnerErrors,
      );
      if (robotsResult) results.push(robotsResult);
    }

    if (kind === "technical" || kind === "sitemap") {
      sitemapResult = await invoke(
        "sitemap",
        sitemap,
        target,
        { ...baseContext, robots_result: robotsResult },
        runnerErrors,
      );
      if (sitemapResult) results.push(sitemapResult);
    }

    if (kind === "technical" || kind === "crawl") {
      if (!robotsResult || !isUsable(robotsResult)) {
        runnerErrors.push({
          code: robotsResult && FAILURE_STATUSES.has(resultStatus(robotsResult))
            ? resultStatus(robotsResult)
            : "unavailable",
          message: "Crawl was not started because robots policy could not be collected reliably",
          adapter: "crawler",
        });
      } else {
        crawlerResult = await invoke(
          "crawler",
          crawler,
          target,
          {
            configuration: config,
            timestamp,
            robots_result: robotsResult,
            sitemap_result: sitemapResult,
            request_budget: requestBudget,
          },
          runnerErrors,
        );
        if (crawlerResult) results.push(crawlerResult);
      }
    }

    const evidence = normalizedEvidence(results);
    const rootOutput = httpResult?.output ?? {};
    const excluded = [rootOutput.requested_url, rootOutput.final_url].filter(Boolean);
    let findings = dedupeFindings([
      ...findingsFromHttp(httpResult),
      ...findingsFromRobots(robotsResult),
      ...findingsFromSitemaps(sitemapResult),
      ...findingsFromCrawler(crawlerResult, {
        sitemapUrls: sitemapUrls(sitemapResult),
        excludeUrls: excluded,
      }),
    ]);
    if (findings.length > MAX_AUDIT_FINDINGS) {
      runnerErrors.push({
        code: "AUDIT_FINDING_LIMIT_REACHED",
        message: `Finding output was capped at ${MAX_AUDIT_FINDINGS} of ${findings.length} candidates`,
        adapter: "audit-run",
      });
      findings = findings.slice(0, MAX_AUDIT_FINDINGS);
    }
    const errors = normalizedErrors(results, runnerErrors);

    return buildRun({
      kind,
      target,
      timestamp,
      config,
      results,
      evidence,
      findings,
      errors,
      createRunId,
      crawlerResult,
      sitemapResult,
      requestBudget,
    });
  };
}

function buildRun({
  kind,
  target,
  timestamp,
  config,
  results,
  evidence,
  findings,
  errors,
  createRunId,
  crawlerResult,
  sitemapResult,
  requestBudget,
}) {
  const adapterVersions = Object.fromEntries(
    results
      .filter((result) => typeof result?.id === "string")
      .map((result) => [result.id, String(result.version ?? "unknown")]),
  );
  const summary = {
    status: overallStatus(results, errors, kind),
    evidence_count: evidence.length,
    finding_count: findings.length,
    error_count: errors.length,
  };
  if (crawlerResult) summary.pages_crawled = crawlPageCount(crawlerResult);
  if (sitemapResult) summary.sitemaps_checked = sitemapCount(sitemapResult);
  summary.request_budget = requestBudgetSnapshot(requestBudget);

  return sanitizeRecord({
    run_id: String(createRunId()),
    kind,
    timestamp,
    target,
    configuration: config,
    adapter_versions: adapterVersions,
    tool_results: results,
    evidence,
    findings,
    errors,
    summary,
  });
}
