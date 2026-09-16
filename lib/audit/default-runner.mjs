import { crawlSite } from "../crawler/index.mjs";
import { createHttpAdapter } from "../http/http-adapter.mjs";
import {
  DEFAULT_MAX_ROBOTS_BYTES,
  evaluateRobotsPolicy,
} from "../robots/robots-parser.mjs";
import { inspectRobots } from "../robots/robots-adapter.mjs";
import { inspectSitemaps } from "../sitemap/sitemap-adapter.mjs";
import { createAuditRunner } from "./audit-run.mjs";

function inspectWith(adapter, input) {
  if (typeof adapter === "function") return adapter(input);
  if (typeof adapter?.inspect === "function") return adapter.inspect(input);
  throw new TypeError("HTTP adapter must be a function or expose inspect(input)");
}

function httpInput(target, configuration, extra = {}) {
  return {
    url: target,
    timeout_ms: configuration.timeout_ms,
    max_body_bytes: configuration.max_body_bytes,
    max_redirects: configuration.max_redirects,
    user_agent: configuration.user_agent,
    ...extra,
  };
}

export function createDefaultAuditRunner({
  httpAdapter = createHttpAdapter(),
  clock,
  createRunId,
} = {}) {
  return createAuditRunner({
    ...(clock ? { clock } : {}),
    ...(createRunId ? { createRunId } : {}),

    http(target, { configuration, request_budget: requestBudget }) {
      return inspectWith(
        httpAdapter,
        httpInput(target, configuration, {audit_budget: requestBudget}),
      );
    },

    robots(target, { configuration, request_budget: requestBudget }) {
      return inspectRobots(
        target,
        {
          timeoutMs: configuration.timeout_ms,
          maxBodyBytes: Math.min(configuration.max_body_bytes, DEFAULT_MAX_ROBOTS_BYTES),
          maxRedirects: configuration.max_redirects,
          userAgent: configuration.user_agent,
          requestBudget,
        },
        { httpAdapter, ...(clock ? { now: clock } : {}) },
      );
    },

    sitemap(target, {
      configuration,
      robots_result: robotsResult,
      request_budget: requestBudget,
    }) {
      const declared = Array.isArray(robotsResult?.output?.sitemaps)
        ? (robotsResult.output.policy?.sitemaps ?? robotsResult.output.sitemaps)
        : [];
      return inspectSitemaps(
        target,
        {
          discoverRobots: false,
          robotsSitemaps: declared,
          includeDefault: true,
          timeoutMs: configuration.timeout_ms,
          maxRedirects: configuration.max_redirects,
          maxBodyBytes: configuration.max_body_bytes,
          maxDepth: configuration.max_sitemap_depth,
          maxSitemaps: configuration.max_sitemaps,
          maxUrls: configuration.max_sitemap_urls,
          userAgent: configuration.user_agent,
          requestBudget,
        },
        { httpAdapter, ...(clock ? { now: clock } : {}) },
      );
    },

    crawler(target, {
      configuration,
      robots_result: robotsResult,
      request_budget: requestBudget,
    }) {
      const parsedRobots = robotsResult?.output?.policy ?? robotsResult?.output?.parsed;
      const robotsPolicy = (url) => {
        const evaluation = evaluateRobotsPolicy(
          parsedRobots,
          configuration.robots_product_token,
          url,
        );
        return {
          allowed: evaluation.allowed === true,
          status: evaluation.allowed === true ? "allowed" : "blocked",
          reason: evaluation.reason,
        };
      };
      const crawlHttp = (url, requestConfiguration = {}) =>
        inspectWith(
          httpAdapter,
          httpInput(url, configuration, {
            ...requestConfiguration,
            timeout_ms: configuration.timeout_ms,
            max_body_bytes: configuration.max_body_bytes,
            max_redirects: configuration.max_redirects,
            audit_budget: requestBudget,
          }),
        );
      return crawlSite(target, {
        httpAdapter: crawlHttp,
        robotsPolicy,
        maxPages: configuration.max_pages,
        concurrency: configuration.concurrency,
        timeoutMs: configuration.timeout_ms,
        redirectLimit: configuration.max_redirects,
        maxLinksPerPage: configuration.max_links_per_page,
        userAgent: configuration.user_agent,
        ...(clock ? { now: clock } : {}),
      });
    },
  });
}

export async function runAudit(kind, target, configuration = {}, options = {}) {
  return createDefaultAuditRunner(options)(kind, target, configuration);
}
