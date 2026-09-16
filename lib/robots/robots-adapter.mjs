import {createHash} from "node:crypto";
import {
  sanitizeRecord,
  sanitizeUrlForRecord,
} from "../security/record-sanitizer.mjs";
import {
  DEFAULT_MAX_ROBOTS_BYTES,
  SUPPORTED_CRAWLERS,
  evaluateRobotsPolicy,
  parseRobotsTxt,
} from "./robots-parser.mjs";

const VERSION = "0.2.0";
const MAX_TARGET_URL_BYTES = 8_192;
const MAX_AUDIT_PATH_BYTES = 8_192;
const MAX_CRAWLER_IDENTIFIERS = 64;
const MAX_CRAWLER_IDENTIFIER_BYTES = 512;

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

function emptyOutput(robotsUrl = null) {
  return {
    robots_url: robotsUrl,
    file_status: "unknown",
    http_status: null,
    groups: [],
    sitemaps: [],
    evaluations: [],
    parse_errors: [],
    raw: null,
    parsed: null,
  };
}

function adapterResult({input, output, evidence, observedAt, status, errors}) {
  const rawBody = output?.raw?.body;
  const policy = output?.parsed;
  const result = sanitizeRecord({
    id: ROBOTS_ADAPTER.id,
    name: ROBOTS_ADAPTER.name,
    version: ROBOTS_ADAPTER.version,
    capabilities: [...ROBOTS_ADAPTER.capabilities],
    input,
    output,
    evidence,
    observed_at: observedAt,
    status,
    errors,
  });
  if (policy && result.output) {
    Object.defineProperty(result.output, "policy", {
      value: policy,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  if (typeof rawBody === "string" && result.output?.raw) {
    Object.defineProperty(result.output.raw, "body", {
      value: rawBody,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result;
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

function copyHttpErrors(result) {
  if (!Array.isArray(result?.errors)) return [];
  const allowed = ["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"];
  return result.errors.map((error) => {
    const code = allowed.includes(error?.code)
      ? error.code
      : allowed.includes(error?.status)
        ? error.status
        : allowed.includes(result?.status)
          ? result.status
        : "UNKNOWN";
    return resultError(code, String(error?.message ?? "HTTP inspection failed"), {
      kind: allowed.includes(error?.code) ? null : String(error?.code ?? "UNKNOWN"),
      upstream: error?.details && typeof error.details === "object" ? error.details : null,
    });
  });
}

function normalizeConfig(config) {
  const outer = config && typeof config === "object" ? config : {};
  const nested = outer.configuration && typeof outer.configuration === "object"
    ? outer.configuration
    : {};
  return {
    ...outer,
    path: outer.path,
    crawlers: outer.crawlers,
    maxBodyBytes:
      outer.maxBodyBytes ?? outer.max_body_bytes ?? nested.max_body_bytes,
    timeoutMs: outer.timeoutMs ?? outer.timeout_ms ?? nested.timeout_ms,
    maxRedirects:
      outer.maxRedirects ?? outer.max_redirects ?? nested.max_redirects,
    userAgent:
      outer.userAgent ?? outer.user_agent ?? nested.user_agent,
    requestBudget: outer.requestBudget ?? outer.request_budget,
  };
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

function byteLength(value) {
  return Buffer.byteLength(String(value));
}

function recordedPath(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "[INVALID PATH]";
  if (byteLength(value) > MAX_AUDIT_PATH_BYTES) {
    return `[OMITTED: path exceeds ${MAX_AUDIT_PATH_BYTES} bytes]`;
  }
  return value;
}

function recordedCrawlers(value) {
  const crawlers = value === undefined ? [...SUPPORTED_CRAWLERS] : value;
  if (!Array.isArray(crawlers)) return [];
  return crawlers.slice(0, MAX_CRAWLER_IDENTIFIERS).map((crawler) => {
    if (typeof crawler !== "string") return "[INVALID CRAWLER IDENTIFIER]";
    if (byteLength(crawler) > MAX_CRAWLER_IDENTIFIER_BYTES) {
      return `[OMITTED: crawler identifier exceeds ${MAX_CRAWLER_IDENTIFIER_BYTES} bytes]`;
    }
    return crawler;
  });
}

function validateEvaluationInputs(config) {
  if (config.path !== undefined) {
    if (typeof config.path !== "string") return "path must be a string";
    if (byteLength(config.path) > MAX_AUDIT_PATH_BYTES) {
      return `path must not exceed ${MAX_AUDIT_PATH_BYTES} bytes`;
    }
  }

  if (config.crawlers !== undefined) {
    if (!Array.isArray(config.crawlers)) return "crawlers must be an array";
    if (config.crawlers.length > MAX_CRAWLER_IDENTIFIERS) {
      return `crawlers must contain at most ${MAX_CRAWLER_IDENTIFIERS} entries`;
    }
    for (const crawler of config.crawlers) {
      if (typeof crawler !== "string" || crawler.length === 0) {
        return "each crawler identifier must be a non-empty string";
      }
      if (byteLength(crawler) > MAX_CRAWLER_IDENTIFIER_BYTES) {
        return `crawler identifiers must not exceed ${MAX_CRAWLER_IDENTIFIER_BYTES} bytes`;
      }
    }
  }
  return null;
}

async function runRobotsInspection(targetUrl, config, dependencies) {
  config = normalizeConfig(config);
  const observedAt = isoTimestamp(dependencies.now);
  const configuredCrawlers = config.crawlers ?? [...SUPPORTED_CRAWLERS];
  const input = {
    target_url: sanitizeUrlForRecord(targetUrl ?? ""),
    path: recordedPath(config.path),
    crawlers: recordedCrawlers(config.crawlers),
    crawler_count: Array.isArray(configuredCrawlers) ? configuredCrawlers.length : null,
    max_body_bytes: config.maxBodyBytes ?? DEFAULT_MAX_ROBOTS_BYTES,
    timeout_ms: config.timeoutMs ?? null,
  };

  const evaluationInputError = validateEvaluationInputs(config);
  if (evaluationInputError) {
    return adapterResult({
      input,
      output: emptyOutput(),
      evidence: [],
      observedAt,
      status: "invalid",
      errors: [resultError("invalid", evaluationInputError)],
    });
  }

  let target;
  try {
    if (Buffer.byteLength(String(targetUrl ?? "")) > MAX_TARGET_URL_BYTES) {
      throw new TypeError(`Target URL exceeds ${MAX_TARGET_URL_BYTES} bytes`);
    }
    target = new URL(targetUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new TypeError("Only http and https targets are supported");
    }
    if (target.username || target.password) {
      throw new TypeError("Target URLs must not contain credentials");
    }
    if (Buffer.byteLength(target.href) > MAX_TARGET_URL_BYTES) {
      throw new TypeError(`Normalized target URL exceeds ${MAX_TARGET_URL_BYTES} bytes`);
    }
  } catch (error) {
    return adapterResult({
      input,
      output: emptyOutput(),
      evidence: [],
      observedAt,
      status: "invalid",
      errors: [resultError("invalid", error.message, {target_url: input.target_url})],
    });
  }

  const maxBodyBytes = input.max_body_bytes;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > DEFAULT_MAX_ROBOTS_BYTES
  ) {
    return adapterResult({
      input,
      output: emptyOutput(),
      evidence: [],
      observedAt,
      status: "invalid",
      errors: [
        resultError(
          "invalid",
          `maxBodyBytes must be an integer between 1 and ${DEFAULT_MAX_ROBOTS_BYTES}`,
        ),
      ],
    });
  }

  const robotsUrl = new URL("/robots.txt", target.origin).href;
  const output = emptyOutput(robotsUrl);
  const requestInput = {
    url: robotsUrl,
    timeout_ms: config.timeoutMs,
    max_body_bytes: maxBodyBytes,
    max_redirects: config.maxRedirects,
    user_agent: config.userAgent,
    audit_budget: config.requestBudget,
    same_origin_only: true,
    allowed_origin: target.origin,
  };

  let httpResult;
  try {
    httpResult = await clientFromDependencies(dependencies)(requestInput);
  } catch (error) {
    const errorStatus = ["UNKNOWN", "unavailable", "timeout", "blocked", "invalid"].includes(
      error?.status,
    )
      ? error.status
      : error?.name === "AbortError"
        ? "timeout"
        : "unavailable";
    return adapterResult({
      input,
      output,
      evidence: [],
      observedAt,
      status: errorStatus,
      errors: [
        resultError(errorStatus, error.message, {
          url: robotsUrl,
          kind: error?.code ?? null,
        }),
      ],
    });
  }

  const httpOutput = responseOutput(httpResult);
  const httpStatus = responseStatusCode(httpResult);
  const body = responseBody(httpResult);
  const raw = {
    requested_url: httpOutput.requested_url ?? robotsUrl,
    final_url: httpOutput.final_url ?? robotsUrl,
    http_status: httpStatus,
    content_type: httpOutput.content_type ?? httpOutput.headers?.["content-type"] ?? null,
    body_bytes: body === null ? null : Buffer.byteLength(body),
    body_sha256:
      body === null ? null : createHash("sha256").update(body).digest("hex"),
  };
  if (body !== null) {
    Object.defineProperty(raw, "body", {
      value: body,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  output.http_status = httpStatus;
  output.raw = raw;

  const evidence = Array.isArray(httpResult?.evidence)
    ? httpResult.evidence
    : httpStatus === null
      ? []
      : [
          {
            state: "OBSERVED",
            source: raw.final_url,
            observed_at: observedAt,
            notes: `robots.txt returned HTTP ${httpStatus}`,
          },
        ];
  const errors = copyHttpErrors(httpResult);
  const upstreamStatus = transportStatus(httpResult);
  if (!["ok", "partial"].includes(upstreamStatus)) {
    if (errors.length === 0) {
      errors.push(
        resultError(upstreamStatus, "robots.txt HTTP inspection did not complete", {
          url: robotsUrl,
        }),
      );
    }
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: upstreamStatus,
      errors,
    });
  }

  if (httpStatus === 404 || httpStatus === 410) {
    const parsed = parseRobotsTxt("", {maxBytes: maxBodyBytes});
    const auditPath = config.path ?? `${target.pathname}${target.search}`;
    const crawlers = configuredCrawlers;
    output.file_status = "absent";
    output.groups = parsed.groups;
    output.sitemaps = parsed.sitemaps;
    output.evaluations = crawlers.map((crawler) => ({
      ...evaluateRobotsPolicy(parsed, crawler, auditPath),
      reason: "robots_file_absent",
    }));
    output.parse_errors = [];
    output.parsed = parsed;
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "ok",
      errors,
    });
  }

  const httpErrorStatus = errorStatusForHttp(httpStatus);
  if (httpErrorStatus) {
    errors.push(
      resultError(httpErrorStatus, `robots.txt returned HTTP ${httpStatus}`, {
        url: raw.final_url,
        http_status: httpStatus,
      }),
    );
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: httpErrorStatus,
      errors,
    });
  }

  if (upstreamStatus === "partial") {
    errors.push(
      resultError(
        "unavailable",
        "robots.txt response bytes were not reliable enough to evaluate safely",
        {url: raw.final_url, kind: "ROBOTS_HTTP_PARTIAL"},
      ),
    );
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "unavailable",
      errors,
    });
  }

  if (body === null) {
    errors.push(
      resultError("unavailable", "robots.txt response body is unavailable", {
        url: raw.final_url,
      }),
    );
    return adapterResult({
      input,
      output,
      evidence,
      observedAt,
      status: "unavailable",
      errors,
    });
  }

  const parsed = parseRobotsTxt(body, {maxBytes: maxBodyBytes});
  const auditPath = config.path ?? `${target.pathname}${target.search}` ?? "/";
  const crawlers = configuredCrawlers;
  const evaluations = crawlers.map((crawler) =>
    evaluateRobotsPolicy(parsed, crawler, auditPath),
  );
  output.groups = parsed.groups;
  output.file_status = "present";
  output.sitemaps = parsed.sitemaps;
  output.evaluations = evaluations;
  output.parse_errors = parsed.parse_errors;
  output.parsed = parsed;

  if (parsed.parse_errors.length) {
    errors.push(
      resultError("invalid", "robots.txt contained malformed directives", {
        parse_error_count: parsed.parse_errors.length,
      }),
    );
  }

  return adapterResult({
    input,
    output,
    evidence,
    observedAt,
    status: parsed.status === "ok" ? upstreamStatus : parsed.status,
    errors,
  });
}

export async function inspectRobots(targetUrl, config = {}, dependencies = {}) {
  return runRobotsInspection(targetUrl, config, dependencies);
}

export function createRobotsAdapter(defaultDependencies = {}) {
  return Object.freeze({
    ...ROBOT_METADATA,
    inspect(targetUrl, config = {}, dependencies = {}) {
      return runRobotsInspection(targetUrl, config, {
        ...defaultDependencies,
        ...dependencies,
      });
    },
  });
}

const ROBOT_METADATA = Object.freeze({
  id: "robots",
  name: "robots.txt adapter",
  version: VERSION,
  capabilities: Object.freeze([
    "robots.fetch",
    "robots.parse",
    "robots.sitemap-discovery",
    "robots.rule-evaluation",
  ]),
});

export const ROBOTS_ADAPTER = Object.freeze({
  ...ROBOT_METADATA,
  inspect: inspectRobots,
});
