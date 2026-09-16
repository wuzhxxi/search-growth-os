import {createHash} from "node:crypto";
import http from "node:http";
import https from "node:https";
import {performance} from "node:perf_hooks";

import {adapterError, createAdapterResult} from "../core/adapter-result.mjs";
import {
  remainingRequestBudgetTime,
  releaseRequestBudget,
  reserveRequestBudget,
} from "../core/request-budget.mjs";
import {
  UrlPolicyError,
  resolveAndPinUrl,
  validateHttpUrl,
} from "../security/url-policy.mjs";
import {
  sanitizeRecord,
  sanitizeTextForRecord,
  sanitizeUrlForRecord,
} from "../security/record-sanitizer.mjs";
import {parseHtmlMetadata} from "./html-parser.mjs";

export const HTTP_ADAPTER = Object.freeze({
  id: "http",
  name: "Public website HTTP inspector",
  version: "0.2.0",
  capabilities: Object.freeze([
    "http.fetch",
    "http.redirect-chain",
    "http.response-headers",
    "html.metadata",
    "html.internal-links",
  ]),
});

export const DEFAULT_HTTP_USER_AGENT =
  "SearchGrowthOS/0.2.0 (+https://github.com/wuzhxxi/search-growth-os; technical-audit)";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 5 * 1_048_576;
const MAX_REDIRECTS = 10;
export const HTTP_LIMITS = Object.freeze({
  default_timeout_ms: DEFAULT_TIMEOUT_MS,
  max_timeout_ms: MAX_TIMEOUT_MS,
  default_max_body_bytes: DEFAULT_MAX_BODY_BYTES,
  max_body_bytes: MAX_BODY_BYTES,
  default_max_redirects: DEFAULT_MAX_REDIRECTS,
  max_redirects: MAX_REDIRECTS,
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RELEVANT_HEADERS = new Set([
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "link",
  "location",
  "retry-after",
  "server",
  "vary",
  "x-robots-tag",
]);

class HttpAdapterError extends Error {
  constructor(code, message, {status = "unavailable", cause} = {}) {
    super(message, {cause});
    this.name = "HttpAdapterError";
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min) {
    throw new HttpAdapterError("INVALID_CONFIGURATION", "Adapter limits must be integers", {
      status: "invalid",
    });
  }
  if (number > max) {
    throw new HttpAdapterError(
      "LIMIT_EXCEEDS_SAFETY_MAXIMUM",
      `Configured limit ${number} exceeds the safety maximum ${max}`,
      {status: "invalid"},
    );
  }
  return number;
}

function normalizedHeaderValue(value) {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value === undefined ? undefined : String(value);
}

function relevantHeaders(headers = {}) {
  const selected = {};
  for (const [originalName, value] of Object.entries(headers)) {
    const name = originalName.toLowerCase();
    if (!RELEVANT_HEADERS.has(name)) continue;
    const normalized = normalizedHeaderValue(value);
    if (normalized !== undefined) selected[name] = sanitizeTextForRecord(normalized);
  }
  return selected;
}

function responseHeader(headers, name) {
  for (const [headerName, value] of Object.entries(headers || {})) {
    if (headerName.toLowerCase() === name) return normalizedHeaderValue(value);
  }
  return undefined;
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  throw new HttpAdapterError("INVALID_TRANSPORT_RESPONSE", "Transport body must be bytes or text");
}

function knownBodyBytes(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength;
  if (typeof body === "string") return Buffer.byteLength(body);
  return 0;
}

function attachResponseBytes(error, responseBytes) {
  if (
    error &&
    (typeof error === "object" || typeof error === "function") &&
    !Object.hasOwn(error, "responseBytes")
  ) {
    error.responseBytes = responseBytes;
  }
  return error;
}

function decodeBody(buffer, contentType) {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType || "")?.[1] || "utf-8";
  try {
    return new TextDecoder(charset, {fatal: false}).decode(buffer);
  } catch {
    return new TextDecoder("utf-8", {fatal: false}).decode(buffer);
  }
}

function isHtml(contentType, body) {
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType || "")) return true;
  if (contentType) return false;
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body);
}

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function initialOutput(requestedUrl) {
  return {
    requested_url: requestedUrl,
    final_url: null,
    http_status: null,
    redirect_chain: [],
    redirected: false,
    content_type: null,
    response_time_ms: null,
    headers: {},
    x_robots_tag: null,
    title: null,
    description: null,
    canonical: null,
    meta_robots: null,
    hreflang: [],
    structured_data: {present: false, count: 0, parsed_count: 0, types: [], parse_errors: []},
    structured_data_present: false,
    internal_links: [],
    raw: {
      responses: [],
      headers: {},
      body_bytes: 0,
      body_sha256: null,
    },
    parsed: null,
  };
}

function normalizeInput(input, defaults) {
  const options = typeof input === "string" || input instanceof URL ? {url: input} : input;
  if (!options || typeof options !== "object") {
    throw new HttpAdapterError("INVALID_INPUT", "HTTP adapter input must include a URL", {
      status: "invalid",
    });
  }

  const url = options.url instanceof URL ? options.url.href : String(options.url ?? "");
  if (!url) {
    throw new HttpAdapterError("INVALID_INPUT", "HTTP adapter input must include a URL", {
      status: "invalid",
    });
  }

  const timeoutMs = boundedInteger(
    options.timeout_ms ?? options.timeoutMs,
    defaults.timeoutMs,
    1,
    MAX_TIMEOUT_MS,
  );
  const maxBodyBytes = boundedInteger(
    options.max_body_bytes ?? options.maxBodyBytes,
    defaults.maxBodyBytes,
    1,
    MAX_BODY_BYTES,
  );
  const maxRedirects = boundedInteger(
    options.max_redirects ?? options.maxRedirects,
    defaults.maxRedirects,
    0,
    MAX_REDIRECTS,
  );
  const userAgent = options.user_agent ?? options.userAgent ?? defaults.userAgent;
  if (
    typeof userAgent !== "string" ||
    !userAgent.trim() ||
    userAgent.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(userAgent)
  ) {
    throw new HttpAdapterError(
      "INVALID_USER_AGENT",
      "userAgent must be a non-empty header-safe string of at most 512 characters",
      {status: "invalid"},
    );
  }

  return {
    ...options,
    url,
    timeoutMs,
    maxBodyBytes,
    maxRedirects,
    userAgent: userAgent.trim(),
  };
}

function inputForResult(input) {
  return {
    url: sanitizeUrlForRecord(input.url),
    timeout_ms: input.timeoutMs,
    max_body_bytes: input.maxBodyBytes,
    max_redirects: input.maxRedirects,
    user_agent: input.userAgent,
    same_origin_only: Boolean(input.sameOriginOnly ?? input.same_origin_only),
  };
}

function normalizeAllowedOrigins(input, requestedUrl) {
  const values = [];
  if (input.allowedOrigin) values.push(input.allowedOrigin);
  if (input.allowed_origin) values.push(input.allowed_origin);
  if (Array.isArray(input.allowedOrigins)) values.push(...input.allowedOrigins);
  if (Array.isArray(input.allowed_origins)) values.push(...input.allowed_origins);
  if (input.sameOriginOnly ?? input.same_origin_only) values.push(requestedUrl.origin);
  if (values.length === 0) return null;

  const origins = new Set();
  for (const value of values) origins.add(validateHttpUrl(value).origin);
  return origins;
}

async function redirectPolicyAllows(input, allowedOrigins, from, to, context) {
  if (from.protocol === "https:" && to.protocol === "http:") return false;
  if (allowedOrigins && !allowedOrigins.has(to.origin)) return false;
  if (typeof input.allowRedirect === "function") {
    return (await input.allowRedirect(from.href, to.href, context)) !== false;
  }
  return true;
}

function errorDetails(error, currentUrl) {
  const status =
    error?.status ||
    (error?.name === "AbortError" || error?.code === "ETIMEDOUT" ? "timeout" : "unavailable");
  const code = error?.code || (status === "timeout" ? "TIMEOUT" : "REQUEST_FAILED");
  return {
    status,
    error: adapterError(code, error?.message || "HTTP request failed", {
      url: sanitizeUrlForRecord(currentUrl),
    }),
  };
}

function finishFailure({error, input, output, evidence, observedAt, currentUrl}) {
  const failure = errorDetails(error, currentUrl);
  const unknownEvidence = {
    state: "UNKNOWN",
    source: sanitizeUrlForRecord(currentUrl || input.url),
    observed_at: null,
    notes: `No HTTP fact was observed for this hop: ${failure.error.code}`,
  };
  return createAdapterResult({
    adapter: HTTP_ADAPTER,
    status: failure.status,
    input: inputForResult(input),
    output,
    evidence: [...evidence, unknownEvidence],
    observedAt,
    errors: [failure.error],
  });
}

export function nodeHttpTransport({url, lookup, headers, timeoutMs, maxBodyBytes}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const started = performance.now();
    let settled = false;
    let timer;
    let responseBytes = 0;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const request = client.request(url, {
      method: "GET",
      headers,
      lookup,
      agent: false,
      maxHeaderSize: 32 * 1024,
    });

    timer = setTimeout(() => {
      const error = new HttpAdapterError("HTTP_TIMEOUT", "HTTP request timed out", {
        status: "timeout",
      });
      error.code = "ETIMEDOUT";
      request.destroy(error);
    }, timeoutMs);
    timer.unref?.();

    request.on("response", (response) => {
      if (
        REDIRECT_STATUSES.has(response.statusCode) &&
        responseHeader(response.headers, "location")
      ) {
        response.destroy();
        finish(resolve, {
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.alloc(0),
          responseTimeMs: Math.max(0, Math.round(performance.now() - started)),
        });
        return;
      }
      const declaredLength = Number(responseHeader(response.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        const error = new HttpAdapterError(
          "BODY_TOO_LARGE",
          `Response body exceeds the ${maxBodyBytes}-byte limit`,
          {status: "blocked"},
        );
        attachResponseBytes(error, responseBytes);
        response.destroy(error);
        finish(reject, error);
        return;
      }

      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        responseBytes = bytes;
        if (bytes > maxBodyBytes) {
          const error = new HttpAdapterError(
            "BODY_TOO_LARGE",
            `Response body exceeds the ${maxBodyBytes}-byte limit`,
            {status: "blocked"},
          );
          attachResponseBytes(error, responseBytes);
          response.destroy(error);
          finish(reject, error);
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        finish(resolve, {
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
          responseTimeMs: Math.max(0, Math.round(performance.now() - started)),
        });
      });
      response.on("aborted", () => {
        const error = attachResponseBytes(
          new HttpAdapterError("RESPONSE_ABORTED", "HTTP response ended before completion"),
          responseBytes,
        );
        finish(
          reject,
          error,
        );
      });
      response.on("error", (error) =>
        finish(reject, attachResponseBytes(error, responseBytes)));
    });
    request.on("error", (error) =>
      finish(reject, attachResponseBytes(error, responseBytes)));
    request.end();
  });
}

export function createHttpAdapter({
  transport = nodeHttpTransport,
  dnsLookup,
  now = () => new Date(),
  userAgent = DEFAULT_HTTP_USER_AGENT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
} = {}) {
  if (typeof transport !== "function") throw new TypeError("transport must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof userAgent !== "string" || !userAgent.trim()) {
    throw new TypeError("userAgent must be a non-empty string");
  }

  const defaults = {
    timeoutMs: boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    maxBodyBytes: boundedInteger(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1, MAX_BODY_BYTES),
    maxRedirects: boundedInteger(maxRedirects, DEFAULT_MAX_REDIRECTS, 0, MAX_REDIRECTS),
    dnsTimeoutMs: boundedInteger(dnsTimeoutMs, DEFAULT_DNS_TIMEOUT_MS, 1, MAX_TIMEOUT_MS),
    userAgent,
  };

  async function inspect(rawInput) {
    const observedAt = isoTimestamp(now);
    let input;
    try {
      input = normalizeInput(rawInput, defaults);
    } catch (error) {
      const placeholder = {
        url:
          typeof rawInput === "string"
            ? rawInput
            : rawInput?.url instanceof URL
              ? rawInput.url.href
              : String(rawInput?.url ?? ""),
        timeoutMs: defaults.timeoutMs,
        maxBodyBytes: defaults.maxBodyBytes,
        maxRedirects: defaults.maxRedirects,
        userAgent: defaults.userAgent,
      };
      return finishFailure({
        error,
        input: placeholder,
        output: initialOutput(sanitizeUrlForRecord(placeholder.url)),
        evidence: [],
        observedAt,
        currentUrl: placeholder.url,
      });
    }

    const output = initialOutput(sanitizeUrlForRecord(input.url));
    const evidence = [];
    let currentUrl;
    let allowedOrigins;
    try {
      currentUrl = validateHttpUrl(input.url);
      output.requested_url = sanitizeUrlForRecord(currentUrl.href);
      allowedOrigins = normalizeAllowedOrigins(input, currentUrl);
    } catch (error) {
      return finishFailure({
        error,
        input,
        output,
        evidence,
        observedAt,
        currentUrl: input.url,
      });
    }

    const visited = new Set([currentUrl.href]);
    let totalResponseTime = 0;

    while (true) {
      let reservation;
      try {
        reservation = reserveRequestBudget(
          input.audit_budget ?? input.auditBudget,
          input.maxBodyBytes,
          input.timeoutMs,
        );
      } catch (error) {
        return finishFailure({
          error,
          input,
          output,
          evidence,
          observedAt,
          currentUrl: currentUrl.href,
        });
      }
      let pinned;
      try {
        pinned = await resolveAndPinUrl(currentUrl, {
          ...(dnsLookup ? {lookup: dnsLookup} : {}),
          dnsTimeoutMs: Math.min(defaults.dnsTimeoutMs, reservation.timeout_ms),
        });
      } catch (error) {
        releaseRequestBudget(reservation);
        return finishFailure({
          error,
          input,
          output,
          evidence,
          observedAt,
          currentUrl: currentUrl.href,
        });
      }

      let response;
      try {
        reservation.timeout_ms = remainingRequestBudgetTime(
          reservation,
          input.timeoutMs,
        );
        response = await transport({
          url: pinned.url,
          lookup: pinned.lookup,
          pinnedAddresses: pinned.addresses.map((item) => ({...item})),
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1",
            "accept-encoding": "identity",
            "user-agent": input.userAgent,
          },
          timeoutMs: reservation.timeout_ms,
          maxBodyBytes: reservation.max_body_bytes,
        });
        remainingRequestBudgetTime(reservation, 1);
      } catch (error) {
        const measuredBytes =
          Number.isSafeInteger(error?.responseBytes) && error.responseBytes >= 0
            ? error.responseBytes
            : response
              ? knownBodyBytes(response.body)
              : error?.code === "BODY_TOO_LARGE"
                ? reservation.max_body_bytes
                : 0;
        if (
          error?.code === "BODY_TOO_LARGE" &&
          reservation.budget &&
          reservation.max_body_bytes < input.maxBodyBytes
        ) {
          reservation.budget.exhausted = true;
          reservation.budget.exhaustion_code = "AUDIT_BYTE_BUDGET_EXCEEDED";
          error = new HttpAdapterError(
            "AUDIT_BYTE_BUDGET_EXCEEDED",
            "Audit Run response-byte budget was exhausted",
            {status: "unavailable", cause: error},
          );
        }
        releaseRequestBudget(reservation, measuredBytes);
        return finishFailure({
          error,
          input,
          output,
          evidence,
          observedAt,
          currentUrl: currentUrl.href,
        });
      }

      let statusCode;
      let body;
      try {
        statusCode = Number(response?.statusCode ?? response?.status);
        if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
          throw new HttpAdapterError(
            "INVALID_TRANSPORT_RESPONSE",
            "Transport returned an invalid HTTP status",
          );
        }
        body = bodyBuffer(response.body);
        if (body.length > reservation.max_body_bytes) {
          const budgetLimited =
            reservation.budget && reservation.max_body_bytes < input.maxBodyBytes;
          if (budgetLimited) {
            reservation.budget.exhausted = true;
            reservation.budget.exhaustion_code = "AUDIT_BYTE_BUDGET_EXCEEDED";
          }
          throw new HttpAdapterError(
            budgetLimited ? "AUDIT_BYTE_BUDGET_EXCEEDED" : "BODY_TOO_LARGE",
            budgetLimited
              ? "Audit Run response-byte budget was exhausted"
              : `Response body exceeds the ${reservation.max_body_bytes}-byte limit`,
            {status: budgetLimited ? "unavailable" : "blocked"},
          );
        }
      } catch (error) {
        releaseRequestBudget(reservation, knownBodyBytes(body));
        return finishFailure({
          error,
          input,
          output,
          evidence,
          observedAt,
          currentUrl: currentUrl.href,
        });
      }
      releaseRequestBudget(reservation, body.length);

      const headers = relevantHeaders(response.headers);
      const responseTime = Math.max(0, Number(response.responseTimeMs) || 0);
      totalResponseTime += responseTime;
      output.response_time_ms = totalResponseTime;
      const hopObservedAt = isoTimestamp(now);
      const rawResponse = {
        url: sanitizeUrlForRecord(currentUrl.href),
        status: statusCode,
        headers,
        resolved_addresses: pinned.addresses.map((item) => ({...item})),
        response_time_ms: responseTime,
        body_bytes: body.length,
      };
      output.raw.responses.push(rawResponse);
      evidence.push({
        state: "OBSERVED",
        source: sanitizeUrlForRecord(currentUrl.href),
        observed_at: hopObservedAt,
        notes: `HTTP ${statusCode} observed by ${HTTP_ADAPTER.id}@${HTTP_ADAPTER.version}`,
      });

      const location = responseHeader(response.headers, "location");
      if (REDIRECT_STATUSES.has(statusCode) && location) {
        let nextUrl;
        try {
          nextUrl = validateHttpUrl(new URL(location, currentUrl));
        } catch (error) {
          return finishFailure({
            error,
            input,
            output,
            evidence,
            observedAt,
            currentUrl: currentUrl.href,
          });
        }

        const redirect = {
          url: sanitizeUrlForRecord(currentUrl.href),
          status: statusCode,
          location: sanitizeTextForRecord(location),
          next_url: sanitizeUrlForRecord(nextUrl.href),
        };
        output.redirect_chain.push(redirect);
        output.redirected = true;

        if (visited.has(nextUrl.href)) {
          return finishFailure({
            error: new HttpAdapterError("REDIRECT_LOOP", "Redirect loop detected", {
              status: "invalid",
            }),
            input,
            output,
            evidence,
            observedAt,
            currentUrl: nextUrl.href,
          });
        }
        if (output.redirect_chain.length > input.maxRedirects) {
          return finishFailure({
            error: new HttpAdapterError("TOO_MANY_REDIRECTS", "Redirect limit exceeded", {
              status: "invalid",
            }),
            input,
            output,
            evidence,
            observedAt,
            currentUrl: nextUrl.href,
          });
        }

        let allowed;
        try {
          allowed = await redirectPolicyAllows(input, allowedOrigins, currentUrl, nextUrl, {
            status: statusCode,
            redirects: output.redirect_chain.length,
          });
        } catch (cause) {
          return finishFailure({
            error: new HttpAdapterError("REDIRECT_POLICY_ERROR", "Redirect policy failed", {
              status: "blocked",
              cause,
            }),
            input,
            output,
            evidence,
            observedAt,
            currentUrl: nextUrl.href,
          });
        }
        if (!allowed) {
          return finishFailure({
            error: new HttpAdapterError(
              "REDIRECT_NOT_ALLOWED",
              "Redirect destination is outside the allowed origin policy",
              {status: "blocked"},
            ),
            input,
            output,
            evidence,
            observedAt,
            currentUrl: nextUrl.href,
          });
        }

        visited.add(nextUrl.href);
        currentUrl = nextUrl;
        continue;
      }

      const contentType = responseHeader(response.headers, "content-type") || null;
      const contentEncoding = responseHeader(response.headers, "content-encoding");
      const decodedBody = decodeBody(body, contentType);
      let parsed = null;
      const errors = [];
      let resultStatus = "ok";

      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        resultStatus = "partial";
        errors.push(
          adapterError(
            "UNSUPPORTED_CONTENT_ENCODING",
            `Response used unsupported content encoding: ${contentEncoding}`,
            {url: currentUrl.href},
          ),
        );
      } else if (isHtml(contentType, decodedBody)) {
        parsed = sanitizeRecord(parseHtmlMetadata(decodedBody, currentUrl.href));
        if (parsed.parse_errors.length > 0) {
          resultStatus = "partial";
          for (const message of parsed.parse_errors) {
            errors.push(adapterError("HTML_PARSE_ERROR", message, {url: currentUrl.href}));
          }
        }
      }

      output.final_url = sanitizeUrlForRecord(currentUrl.href);
      output.http_status = statusCode;
      output.content_type = contentType;
      output.response_time_ms = totalResponseTime;
      output.headers = headers;
      output.x_robots_tag = responseHeader(response.headers, "x-robots-tag") || null;
      output.raw.headers = headers;
      Object.defineProperty(output.raw, "body", {
        value: decodedBody,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      output.raw.body_bytes = body.length;
      output.raw.body_sha256 = createHash("sha256").update(body).digest("hex");
      output.parsed = parsed;

      if (parsed) {
        output.title = parsed.title;
        output.description = parsed.description;
        output.canonical = parsed.canonical;
        output.meta_robots = parsed.meta_robots;
        output.hreflang = parsed.hreflang;
        output.structured_data = parsed.structured_data;
        output.structured_data_present = parsed.structured_data.present;
        output.internal_links = parsed.internal_links;
      }

      return createAdapterResult({
        adapter: HTTP_ADAPTER,
        status: resultStatus,
        input: inputForResult(input),
        output,
        evidence,
        observedAt,
        errors,
      });
    }
  }

  return Object.freeze({...HTTP_ADAPTER, inspect});
}

export async function inspectHttp(input, options) {
  return createHttpAdapter(options).inspect(input);
}

export default inspectHttp;
