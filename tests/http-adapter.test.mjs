import test from "node:test";
import assert from "node:assert/strict";

import {createHttpAdapter} from "../lib/http/http-adapter.mjs";
import {parseHtmlMetadata} from "../lib/http/html-parser.mjs";
import {createRequestBudget} from "../lib/core/request-budget.mjs";

const PUBLIC_ADDRESS = Object.freeze([{address: "93.184.216.34", family: 4}]);
const FIXED_NOW = () => new Date("2026-01-02T03:04:05.000Z");
const publicDns = async () => PUBLIC_ADDRESS;

function mockTransport(routes) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    const route = routes[request.url.href];
    if (route instanceof Error) throw route;
    if (!route) throw new Error(`No mock route for ${request.url.href}`);
    return typeof route === "function" ? route(request) : route;
  };
  transport.calls = calls;
  return transport;
}

test("HTML parser extracts metadata and same-origin links from deterministic markup", () => {
  const parsed = parseHtmlMetadata(
    `<!doctype html><html><head>
      <title> A &amp; B </title>
      <meta name="description" content="A useful page">
      <meta name="robots" content="noindex, follow">
      <meta name="googlebot" content="max-snippet:50">
      <link rel="canonical" href="/canonical">
      <link rel="alternate" hreflang="zh-CN" href="/zh">
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head><body>
      <a href="/inside#section">Inside</a>
      <a href="https://example.test/inside">Duplicate</a>
      <a href="https://outside.test/">Outside</a>
      <a href="mailto:a@example.test">Email</a>
    </body></html>`,
    "https://example.test/page",
  );

  assert.equal(parsed.title, "A & B");
  assert.equal(parsed.description, "A useful page");
  assert.equal(parsed.canonical, "https://example.test/canonical");
  assert.equal(parsed.meta_robots, "noindex, follow");
  assert.equal(parsed.noindex, true);
  assert.deepEqual(parsed.hreflang, [
    {lang: "zh-CN", href: "https://example.test/zh"},
  ]);
  assert.deepEqual(parsed.structured_data.types, ["Article"]);
  assert.deepEqual(parsed.internal_links, ["https://example.test/inside"]);
});

test("malformed HTML and JSON-LD produce parsed facts without throwing", () => {
  const parsed = parseHtmlMetadata(
    `<title>Unclosed title<meta name=robots content=noindex>
     <link rel=canonical href=/good>
     <script type=application/ld+json>{bad json}</script>`,
    "https://example.test/a",
  );
  assert.equal(parsed.title, "Unclosed title");
  assert.equal(parsed.canonical, "https://example.test/good");
  assert.equal(parsed.meta_robots, "noindex");
  assert.equal(parsed.structured_data.present, true);
  assert.equal(parsed.structured_data.parsed_count, 0);
  assert.equal(parsed.parse_errors.length, 1);
});

test("HTTP adapter returns bounded raw facts and separately parsed HTML output", async () => {
  const body = `<!doctype html><html><head>
    <title>Fixture page</title>
    <meta name="description" content="Fixture description">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="/preferred">
    <link rel="alternate" hreflang="en" href="/en">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>
    </head><body><a href="/next">Next</a></body></html>`;
  const transport = mockTransport({
    "https://public.example/page": {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "index, max-image-preview:large",
        "Set-Cookie": "secret=must-not-be-recorded",
      },
      body,
      responseTimeMs: 17,
    },
  });
  const adapter = createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW});
  const result = await adapter.inspect({url: "https://public.example/page"});

  assert.equal(result.status, "ok");
  assert.equal(result.id, "http");
  assert.equal(result.output.final_url, "https://public.example/page");
  assert.equal(result.output.http_status, 200);
  assert.equal(result.output.content_type, "text/html; charset=utf-8");
  assert.equal(result.output.response_time_ms, 17);
  assert.equal(result.output.x_robots_tag, "index, max-image-preview:large");
  assert.equal(result.output.title, "Fixture page");
  assert.equal(result.output.description, "Fixture description");
  assert.equal(result.output.canonical, "https://public.example/preferred");
  assert.equal(result.output.meta_robots, "index,follow");
  assert.deepEqual(result.output.hreflang, [
    {lang: "en", href: "https://public.example/en"},
  ]);
  assert.equal(result.output.structured_data.present, true);
  assert.deepEqual(result.output.internal_links, ["https://public.example/next"]);
  assert.equal(result.output.raw.body, body);
  assert.equal(JSON.parse(JSON.stringify(result)).output.raw.body, undefined);
  assert.equal(result.output.raw.body_bytes, Buffer.byteLength(body));
  assert.match(result.output.raw.body_sha256, /^[a-f\d]{64}$/);
  assert.equal(result.output.raw.headers["set-cookie"], undefined);
  assert.equal(result.output.parsed.title, "Fixture page");
  assert.deepEqual(result.evidence, [
    {
      state: "OBSERVED",
      source: "https://public.example/page",
      observed_at: "2026-01-02T03:04:05.000Z",
      notes: "HTTP 200 observed by http@0.2.0",
    },
  ]);
  assert.equal(transport.calls[0].headers["user-agent"].startsWith("SearchGrowthOS/"), true);
  assert.equal(result.input.user_agent, transport.calls[0].headers["user-agent"]);
  assert.deepEqual(transport.calls[0].pinnedAddresses, PUBLIC_ADDRESS);
  assert.deepEqual(result.output.raw.responses[0].resolved_addresses, PUBLIC_ADDRESS);
});

test("redirect chain is manually followed and a final 404 remains an observed result", async () => {
  let dnsCalls = 0;
  const transport = mockTransport({
    "https://public.example/start": {
      statusCode: 301,
      headers: {location: "/missing"},
      body: "redirect",
      responseTimeMs: 3,
    },
    "https://public.example/missing": {
      statusCode: 404,
      headers: {"content-type": "text/html"},
      body: "<title>Missing</title>",
      responseTimeMs: 4,
    },
  });
  const adapter = createHttpAdapter({
    transport,
    dnsLookup: async () => {
      dnsCalls += 1;
      return PUBLIC_ADDRESS;
    },
    now: FIXED_NOW,
  });
  const result = await adapter.inspect({url: "https://public.example/start"});

  assert.equal(result.status, "ok");
  assert.equal(result.output.http_status, 404);
  assert.equal(result.output.final_url, "https://public.example/missing");
  assert.equal(result.output.response_time_ms, 7);
  assert.deepEqual(result.output.redirect_chain, [
    {
      url: "https://public.example/start",
      status: 301,
      location: "/missing",
      next_url: "https://public.example/missing",
    },
  ]);
  assert.equal(transport.calls.length, 2);
  assert.equal(dnsCalls, 2, "DNS is resolved and pinned independently for every hop");
});

test("redirect loops stop at the adapter boundary", async () => {
  const transport = mockTransport({
    "https://public.example/a": {statusCode: 301, headers: {location: "/b"}, body: ""},
    "https://public.example/b": {statusCode: 302, headers: {location: "/a"}, body: ""},
  });
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/a",
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.errors[0].code, "REDIRECT_LOOP");
  assert.equal(transport.calls.length, 2);
});

test("timeout and oversized bodies return explicit non-success statuses", async (t) => {
  await t.test("timeout", async () => {
    const timeout = new Error("fixture timed out");
    timeout.code = "ETIMEDOUT";
    const transport = mockTransport({"https://public.example/slow": timeout});
    const result = await createHttpAdapter({
      transport,
      dnsLookup: publicDns,
      now: FIXED_NOW,
    }).inspect({url: "https://public.example/slow", timeout_ms: 10});
    assert.equal(result.status, "timeout");
    assert.equal(result.errors[0].code, "ETIMEDOUT");
  });

  await t.test("oversized", async () => {
    const transport = mockTransport({
      "https://public.example/large": {statusCode: 200, headers: {}, body: "12345"},
    });
    const result = await createHttpAdapter({
      transport,
      dnsLookup: publicDns,
      now: FIXED_NOW,
    }).inspect({url: "https://public.example/large", max_body_bytes: 4});
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "BODY_TOO_LARGE");
  });
});

test("configuration above hard safety ceilings is rejected instead of clamped", async () => {
  const transport = mockTransport({});
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/",
    max_body_bytes: 5 * 1_048_576 + 1,
  });
  assert.equal(result.status, "invalid");
  assert.equal(result.errors[0].code, "LIMIT_EXCEEDS_SAFETY_MAXIMUM");
  assert.equal(transport.calls.length, 0);
});

test("private inputs and DNS answers are rejected before transport", async (t) => {
  await t.test("private literal", async () => {
    const transport = mockTransport({});
    const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
      url: "http://127.0.0.1/admin",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "FORBIDDEN_IP");
    assert.equal(transport.calls.length, 0);
  });

  await t.test("private DNS answer", async () => {
    const transport = mockTransport({});
    const result = await createHttpAdapter({
      transport,
      dnsLookup: async () => [{address: "10.20.30.40", family: 4}],
      now: FIXED_NOW,
    }).inspect({url: "https://internal.example/"});
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "FORBIDDEN_DNS_ADDRESS");
    assert.equal(transport.calls.length, 0);
  });

  await t.test("redirect to private literal", async () => {
    const transport = mockTransport({
      "https://public.example/start": {
        statusCode: 302,
        headers: {location: "http://169.254.169.254/latest/meta-data/"},
        body: "",
      },
    });
    const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
      url: "https://public.example/start",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "FORBIDDEN_IP");
    assert.equal(transport.calls.length, 1);
  });
});

test("same-origin redirect policy prevents cross-origin transport", async () => {
  const transport = mockTransport({
    "https://public.example/start": {
      statusCode: 302,
      headers: {location: "https://other.example/landing"},
      body: "",
    },
  });
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/start",
    sameOriginOnly: true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.errors[0].code, "REDIRECT_NOT_ALLOWED");
  assert.equal(transport.calls.length, 1);
});

test("per-input user agent is validated and sent to the transport", async () => {
  const transport = mockTransport({
    "https://public.example/": {statusCode: 200, headers: {}, body: "ok"},
  });
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/",
    user_agent: "FixtureCrawler/1.0",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.input.user_agent, "FixtureCrawler/1.0");
  assert.equal(transport.calls[0].headers["user-agent"], "FixtureCrawler/1.0");
});

test("async redirect policy is awaited before another hop is fetched", async () => {
  const policyCalls = [];
  const transport = mockTransport({
    "https://public.example/start": {
      statusCode: 302,
      headers: {location: "/private"},
      body: "",
    },
  });
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/start",
    allowRedirect: async (from, to, context) => {
      await Promise.resolve();
      policyCalls.push({from, to, context});
      return false;
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.errors[0].code, "REDIRECT_NOT_ALLOWED");
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(policyCalls, [
    {
      from: "https://public.example/start",
      to: "https://public.example/private",
      context: {status: 302, redirects: 1},
    },
  ]);
});

test("HTTPS downgrade and credential-bearing redirects are blocked without a second request", async (t) => {
  await t.test("HTTPS to HTTP downgrade", async () => {
    const transport = mockTransport({
      "https://public.example/start": {
        statusCode: 302,
        headers: {location: "http://public.example/plaintext"},
        body: "",
      },
    });
    const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
      url: "https://public.example/start",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "REDIRECT_NOT_ALLOWED");
    assert.equal(transport.calls.length, 1);
  });

  await t.test("URL credentials", async () => {
    const transport = mockTransport({
      "https://public.example/start": {
        statusCode: 302,
        headers: {location: "https://user:redirect-secret@public.example/private"},
        body: "",
      },
    });
    const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
      url: "https://public.example/start",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0].code, "URL_CREDENTIALS_BLOCKED");
    assert.equal(transport.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /redirect-secret/);
  });
});

test("shared request budget stops subsequent requests before transport", async () => {
  const budget = createRequestBudget({maxRequests: 1, maxResponseBytes: 1_024});
  const transport = mockTransport({
    "https://public.example/one": {statusCode: 200, headers: {}, body: "one"},
    "https://public.example/two": {statusCode: 200, headers: {}, body: "two"},
  });
  const adapter = createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW});
  const first = await adapter.inspect({url: "https://public.example/one", audit_budget: budget});
  const second = await adapter.inspect({url: "https://public.example/two", audit_budget: budget});

  assert.equal(first.status, "ok");
  assert.equal(second.status, "unavailable");
  assert.equal(second.errors[0].code, "AUDIT_REQUEST_BUDGET_EXCEEDED");
  assert.equal(transport.calls.length, 1);
});

test("shared response-byte budget stops subsequent requests before transport", async () => {
  const budget = createRequestBudget({maxRequests: 2, maxResponseBytes: 1_024});
  const transport = mockTransport({
    "https://public.example/full": {
      statusCode: 200,
      headers: {},
      body: "x".repeat(1_024),
    },
    "https://public.example/never": {statusCode: 200, headers: {}, body: "never"},
  });
  const adapter = createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW});
  const first = await adapter.inspect({url: "https://public.example/full", audit_budget: budget});
  const second = await adapter.inspect({url: "https://public.example/never", audit_budget: budget});

  assert.equal(first.status, "ok");
  assert.equal(second.status, "unavailable");
  assert.equal(second.errors[0].code, "AUDIT_BYTE_BUDGET_EXCEEDED");
  assert.equal(transport.calls.length, 1);
});

test("a response that overruns the remaining shared byte reservation exhausts the budget", async () => {
  const budget = createRequestBudget({maxRequests: 3, maxResponseBytes: 1_024});
  const transport = mockTransport({
    "https://public.example/first": {statusCode: 200, headers: {}, body: "x".repeat(512)},
    "https://public.example/overrun": {statusCode: 200, headers: {}, body: "y".repeat(513)},
    "https://public.example/never": {statusCode: 200, headers: {}, body: "never"},
  });
  const adapter = createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW});

  assert.equal(
    (await adapter.inspect({url: "https://public.example/first", audit_budget: budget})).status,
    "ok",
  );
  const overrun = await adapter.inspect({
    url: "https://public.example/overrun",
    audit_budget: budget,
  });
  const after = await adapter.inspect({
    url: "https://public.example/never",
    audit_budget: budget,
  });

  assert.equal(overrun.status, "unavailable");
  assert.equal(overrun.errors[0].code, "AUDIT_BYTE_BUDGET_EXCEEDED");
  assert.equal(after.status, "unavailable");
  assert.equal(after.errors[0].code, "AUDIT_BYTE_BUDGET_EXCEEDED");
  assert.equal(transport.calls.length, 2);
});

test("DNS and transport share one wall-clock deadline", async () => {
  const budget = createRequestBudget({
    maxRequests: 1,
    maxResponseBytes: 1_024,
    maxDurationMs: 100,
  });
  let transportCalls = 0;
  const adapter = createHttpAdapter({
    dnsLookup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return PUBLIC_ADDRESS;
    },
    transport: async () => {
      transportCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 70));
      return {statusCode: 200, headers: {}, body: "late"};
    },
    now: FIXED_NOW,
  });

  const result = await adapter.inspect({
    url: "https://public.example/deadline",
    audit_budget: budget,
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.errors[0].code, "AUDIT_DEADLINE_EXCEEDED");
  assert.equal(transportCalls, 1);
  assert.equal(budget.exhausted, true);
});

test("HTML URL collection omits credentials and is bounded", () => {
  const links = Array.from({length: 600}, (_, index) => `<a href="/page-${index}">x</a>`).join("");
  const parsed = parseHtmlMetadata(
    `<base href="https://user:base-secret@example.test/">
     <link rel="canonical" href="https://user:canonical-secret@example.test/canonical">
     <a href="https://user:link-secret@example.test/private">private</a>${links}`,
    "https://example.test/",
  );

  assert.equal(parsed.canonical, null);
  assert.equal(parsed.internal_links.length, 500);
  assert.equal(parsed.parsed_urls_truncated, true);
  assert.match(parsed.parse_errors.join(" "), /safety limit/i);
  assert.doesNotMatch(JSON.stringify(parsed), /base-secret|canonical-secret|link-secret/);
});

test("HTML parser stops at its tag scan limit on adversarial input", () => {
  const parsed = parseHtmlMetadata(
    `${"<meta name=x content=y>".repeat(10_100)}<a href="/after-limit">late</a>`,
    "https://example.test/",
  );
  assert.match(parsed.parse_errors.join(" "), /10000-tag safety limit/i);
  assert.deepEqual(parsed.internal_links, []);
});

test("JSON-LD traversal is iterative and bounded", () => {
  const values = `${"0,".repeat(100_000)}0`;
  const parsed = parseHtmlMetadata(
    `<script type="application/ld+json">[${values}]</script>`,
    "https://example.test/",
  );

  assert.equal(parsed.structured_data.present, true);
  assert.equal(parsed.structured_data.truncated, true);
  assert.match(parsed.structured_data.parse_errors.join(" "), /node safety limit/i);
});

test("malformed JSON-LD is preserved as a partial observation", async () => {
  const transport = mockTransport({
    "https://public.example/malformed": {
      statusCode: 200,
      headers: {"content-type": "text/html"},
      body: '<title>Still usable</title><script type="application/ld+json">{bad}</script>',
    },
  });
  const result = await createHttpAdapter({transport, dnsLookup: publicDns, now: FIXED_NOW}).inspect({
    url: "https://public.example/malformed",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.output.title, "Still usable");
  assert.equal(result.output.structured_data.present, true);
  assert.equal(result.output.structured_data.parse_errors.length, 1);
  assert.equal(result.errors[0].code, "HTML_PARSE_ERROR");
});
