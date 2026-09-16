import test from "node:test";
import assert from "node:assert/strict";

import {
  CRAWLER_ADAPTER,
  crawlSite,
  crawlSiteOutput,
  createCrawler,
  deriveCrawlIssues,
  findOrphanCandidates,
} from "../lib/crawler/index.mjs";
import {createHttpAdapter} from "../lib/http/http-adapter.mjs";

const ORIGIN = "https://example.test";
const ALLOW_ALL_ROBOTS = () => ({allowed: true, reason: "fixture_allow"});
const FIXED_TIMES = [
  "2026-01-02T03:04:05.000Z",
  "2026-01-02T03:04:06.000Z",
  "2026-01-02T03:04:07.000Z",
  "2026-01-02T03:04:08.000Z",
  "2026-01-02T03:04:09.000Z",
  "2026-01-02T03:04:10.000Z",
];

function fixedClock() {
  let index = 0;
  return () => new Date(FIXED_TIMES[Math.min(index++, FIXED_TIMES.length - 1)]);
}

function mockAdapter(fixtures, calls = []) {
  return async (url, config) => {
    calls.push({ url, config });
    const output = fixtures[url];
    if (!output) throw Object.assign(new Error(`Missing fixture for ${url}`), { code: "INVALID" });
    return {
      observed_at: "2026-01-02T03:04:05.000Z",
      output: {
        requested_url: url,
        final_url: url,
        http_status: 200,
        content_type: "text/html; charset=utf-8",
        redirect_chain: [],
        title: null,
        canonical: null,
        meta_robots: null,
        internal_links: [],
        ...output,
      },
      errors: [],
    };
  };
}

test("crawlSite stays on origin, deduplicates links, and prevents crawl loops", async () => {
  const calls = [];
  const httpAdapter = mockAdapter(
    {
      [`${ORIGIN}/`]: {
        title: "Home",
        internal_links: [
          "/about",
          `${ORIGIN}/about#team`,
          `${ORIGIN}/about`,
          "https://outside.test/page",
          "mailto:hello@example.test",
        ],
      },
      [`${ORIGIN}/about`]: {
        title: "About",
        internal_links: ["/", "/about#top"],
      },
    },
    calls,
  );

  const envelope = await crawlSite(`${ORIGIN}/`, {
    httpAdapter,
    robotsPolicy: ALLOW_ALL_ROBOTS,
    maxPages: 10,
    concurrency: 3,
    now: fixedClock(),
  });
  const result = envelope.output;

  assert.equal(envelope.status, "ok");
  assert.equal(envelope.id, CRAWLER_ADAPTER.id);
  assert.equal(envelope.evidence.length, 2);
  assert.deepEqual(
    calls.map((entry) => entry.url),
    [`${ORIGIN}/`, `${ORIGIN}/about`],
  );
  assert.deepEqual(result.discovered_urls, [`${ORIGIN}/`, `${ORIGIN}/about`]);
  assert.equal(result.pages[0].crawl_depth, 0);
  assert.equal(result.pages[1].crawl_depth, 1);
  assert.deepEqual(result.pages[1].discovered_from, [`${ORIGIN}/`]);
  assert.deepEqual(result.pages[0].internal_links, [`${ORIGIN}/about`]);
  assert.equal(result.configuration.same_origin_only, true);
  assert.equal(calls[0].config.allowedOrigin, ORIGIN);
  assert.equal(calls[0].config.timeoutMs, 10_000);
  assert.equal(calls[0].config.redirectLimit, 5);
  assert.match(calls[0].config.userAgent, /SearchGrowthOS/);
});

test("crawlSite enforces the configured page limit before scheduling work", async () => {
  const calls = [];
  const httpAdapter = mockAdapter(
    {
      [`${ORIGIN}/`]: { internal_links: ["/a", "/b", "/c"] },
      [`${ORIGIN}/a`]: {},
      [`${ORIGIN}/b`]: {},
      [`${ORIGIN}/c`]: {},
    },
    calls,
  );

  const result = await crawlSiteOutput(`${ORIGIN}/`, {
    httpAdapter,
    robotsPolicy: ALLOW_ALL_ROBOTS,
    maxPages: 2,
    concurrency: 8,
    now: fixedClock(),
  });

  assert.deepEqual(
    calls.map((entry) => entry.url),
    [`${ORIGIN}/`, `${ORIGIN}/a`],
  );
  assert.equal(result.pages.length, 2);
  assert.equal(result.summary.page_limit_reached, true);
  assert.equal(result.summary.queued_but_not_crawled, 2);
});

test("crawlSite records redirect, broken-link, canonical, noindex, and important URL facts", async () => {
  const httpAdapter = mockAdapter({
    [`${ORIGIN}/old`]: {
      final_url: `${ORIGIN}/new`,
      title: "Moved page",
      redirect_chain: [
        { url: `${ORIGIN}/old`, status: 301, location: `${ORIGIN}/new` },
      ],
      internal_links: ["/new", "/dead", "/canonical", "/hidden"],
    },
    [`${ORIGIN}/dead`]: {
      http_status: 404,
      title: "Not found",
    },
    [`${ORIGIN}/canonical`]: {
      canonical: "/preferred",
      title: "Canonical test",
    },
    [`${ORIGIN}/hidden`]: {
      meta_robots: "max-snippet:-1, noindex, follow",
      title: "Hidden",
    },
  });

  const result = await crawlSiteOutput(`${ORIGIN}/old`, {
    httpAdapter,
    robotsPolicy: ALLOW_ALL_ROBOTS,
    maxPages: 10,
    importantUrls: [`${ORIGIN}/old`, `${ORIGIN}/dead`],
    now: fixedClock(),
  });

  assert.deepEqual(
    result.pages.map((page) => page.requested_url),
    [`${ORIGIN}/old`, `${ORIGIN}/dead`, `${ORIGIN}/canonical`, `${ORIGIN}/hidden`],
  );
  assert.equal(result.pages[0].redirect, true);
  assert.equal(result.pages[0].final_url, `${ORIGIN}/new`);

  const issueTypes = result.issues.map((issue) => issue.type);
  assert.deepEqual(issueTypes, [
    "redirect_chain",
    "broken_internal_link",
    "non_2xx_important_url",
    "canonical_difference",
    "noindex",
  ]);
  assert.ok(result.issues.every((issue) => issue.classification === "OBSERVED"));
  assert.ok(result.issues.every((issue) => issue.evidence.state === "OBSERVED"));

  const broken = result.issues.find((issue) => issue.type === "broken_internal_link");
  assert.equal(broken.http_status, 404);
  assert.deepEqual(broken.source_urls, [`${ORIGIN}/new`]);
  const canonical = result.issues.find((issue) => issue.type === "canonical_difference");
  assert.equal(canonical.canonical, `${ORIGIN}/preferred`);
});

test("robotsPolicy can disallow a URL without invoking the HTTP adapter", async () => {
  const calls = [];
  const httpAdapter = mockAdapter(
    {
      [`${ORIGIN}/`]: { internal_links: ["/private", "/public"] },
      [`${ORIGIN}/private`]: {},
      [`${ORIGIN}/public`]: {},
    },
    calls,
  );

  const result = await crawlSiteOutput(`${ORIGIN}/`, {
    httpAdapter,
    maxPages: 3,
    concurrency: 2,
    robotsPolicy: (url) => ({
      allowed: !url.endsWith("/private"),
      reason: url.endsWith("/private") ? "fixture_disallow" : "fixture_allow",
    }),
    now: fixedClock(),
  });

  assert.deepEqual(
    calls.map((entry) => entry.url),
    [`${ORIGIN}/`, `${ORIGIN}/public`],
  );
  assert.deepEqual(result.skipped, [
    {
      url: `${ORIGIN}/private`,
      crawl_depth: 1,
      status: "blocked",
      reason: "fixture_disallow",
    },
  ]);
  assert.equal(result.summary.requests_made, 2);
});

test("createCrawler supports an object HTTP adapter and snake_case input", async () => {
  const inputs = [];
  const crawler = createCrawler({
    robotsPolicy: ALLOW_ALL_ROBOTS,
    httpAdapter: {
      async inspect(input) {
        inputs.push(input);
        return {
          output: {
            requested_url: input.url,
            final_url: input.url,
            http_status: 200,
            content_type: "text/html",
            redirect_chain: [],
            title: "Object adapter",
            canonical: null,
            meta_robots: null,
            internal_links: [],
          },
        };
      },
    },
    now: fixedClock(),
  });

  const result = await crawler.crawl({ target_url: `${ORIGIN}/`, max_pages: 1 });
  assert.equal(crawler.id, CRAWLER_ADAPTER.id);
  assert.equal(result.status, "ok");
  assert.equal(result.output.pages[0].title, "Object adapter");
  assert.equal(inputs[0].url, `${ORIGIN}/`);
  assert.equal(inputs[0].sameOriginOnly, true);
});

test("adapter failures remain explicit instead of becoming page facts", async () => {
  const result = await crawlSite(`${ORIGIN}/`, {
    robotsPolicy: ALLOW_ALL_ROBOTS,
    httpAdapter: async () => {
      throw Object.assign(new Error("fixture request timed out"), { code: "ETIMEDOUT" });
    },
    maxPages: 1,
    now: fixedClock(),
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.output.pages.length, 0);
  assert.deepEqual(result.errors, [
    {
      code: "CRAWLER_HTTP_TIMEOUT",
      message: "fixture request timed out",
      status: "timeout",
      stage: "http",
      url: `${ORIGIN}/`,
      crawl_depth: 0,
    },
  ]);
});

test("an upstream blocked adapter envelope is preserved without inventing a page", async () => {
  const result = await crawlSite(`${ORIGIN}/`, {
    robotsPolicy: ALLOW_ALL_ROBOTS,
    httpAdapter: async (url) => ({
      status: "blocked",
      observed_at: "2026-01-02T03:04:05.000Z",
      output: {
        requested_url: url,
        final_url: null,
        http_status: null,
        redirect_chain: [],
        internal_links: [],
      },
      errors: [{ code: "PRIVATE_ADDRESS", message: "Destination is not public" }],
    }),
    maxPages: 1,
    now: fixedClock(),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.output.pages.length, 0);
  assert.equal(result.errors[0].status, "blocked");
  assert.equal(result.evidence.length, 0);
});

test("deriveCrawlIssues does not claim an unobserved broken link", () => {
  const issues = deriveCrawlIssues([
    {
      requested_url: `${ORIGIN}/missing`,
      final_url: `${ORIGIN}/missing`,
      http_status: null,
      redirect_chain: [],
      canonical: null,
      meta_robots: null,
      observed_at: null,
    },
  ]);
  assert.deepEqual(issues, []);
});

test("findOrphanCandidates is explicitly scoped and candidate-only", () => {
  const candidates = findOrphanCandidates(
    [`${ORIGIN}/`, `${ORIGIN}/found#fragment`, `${ORIGIN}/candidate`, "https://other.test/out"],
    [{ requested_url: `${ORIGIN}/` }, `${ORIGIN}/found`],
    { origin: ORIGIN },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, `${ORIGIN}/candidate`);
  assert.equal(candidates[0].classification, "CANDIDATE");
  assert.equal(candidates[0].conclusion, "INFERRED");
  assert.equal(candidates[0].evidence_state, "INFERRED");
  assert.equal(candidates[0].evidence.state, "OBSERVED");
  assert.match(candidates[0].scope, /sitemap/i);
  assert.match(candidates[0].limitation, /do not prove/i);
});

test("unsafe schemes and unbounded crawl settings return explicit invalid results", async () => {
  const scheme = await crawlSite("file:///etc/passwd", { httpAdapter: async () => ({}) });
  const pages = await crawlSite(`${ORIGIN}/`, {
    httpAdapter: async () => ({}),
    maxPages: 1_001,
  });
  const concurrency = await crawlSite(`${ORIGIN}/`, {
    httpAdapter: async () => ({}),
    concurrency: 11,
  });

  assert.equal(scheme.status, "invalid");
  assert.match(scheme.errors[0].message, /absolute http or https URL/);
  assert.equal(pages.status, "invalid");
  assert.match(pages.errors[0].message, /maxPages must be an integer between 1 and 1000/);
  assert.equal(concurrency.status, "invalid");
  assert.match(concurrency.errors[0].message, /concurrency must be an integer between 1 and 10/);
});

test("crawler refuses to fetch when no robots policy is available", async () => {
  let calls = 0;
  const result = await crawlSite(`${ORIGIN}/`, {
    httpAdapter: async () => {
      calls += 1;
      return {};
    },
  });

  assert.equal(result.status, "invalid");
  assert.match(result.errors[0].message, /robotsPolicy is required/);
  assert.equal(calls, 0);
});

test("crawler fails closed when a robots policy result is indeterminate", async () => {
  let calls = 0;
  const result = await crawlSite(`${ORIGIN}/`, {
    httpAdapter: async () => {
      calls += 1;
      return {};
    },
    robotsPolicy: () => ({allowed: null, status: "unavailable"}),
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.output.pages.length, 0);
  assert.equal(result.output.skipped[0].reason, "robots_policy_indeterminate");
  assert.equal(calls, 0);
});

test("crawler rechecks robots policy for every redirect hop", async () => {
  const transportCalls = [];
  const transport = async (request) => {
    transportCalls.push(request.url.href);
    if (request.url.href === `${ORIGIN}/start`) {
      return {statusCode: 302, headers: {location: "/private"}, body: ""};
    }
    throw new Error(`Unexpected transport call: ${request.url.href}`);
  };
  const robotsCalls = [];
  const adapter = createHttpAdapter({
    transport,
    dnsLookup: async () => [{address: "93.184.216.34", family: 4}],
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });

  const result = await crawlSite(`${ORIGIN}/start`, {
    httpAdapter: adapter,
    maxPages: 2,
    robotsPolicy: async (url, context) => {
      robotsCalls.push({url, redirect: Boolean(context.redirect)});
      return {allowed: !url.endsWith("/private"), reason: "fixture"};
    },
    now: fixedClock(),
  });

  assert.deepEqual(transportCalls, [`${ORIGIN}/start`]);
  assert.deepEqual(robotsCalls, [
    {url: `${ORIGIN}/start`, redirect: false},
    {url: `${ORIGIN}/private`, redirect: true},
  ]);
  assert.equal(result.status, "partial");
  assert.equal(result.errors[0].status, "blocked");
});

test("access-control responses stop the crawl without expanding their links", async (t) => {
  for (const status of [403, 429]) {
    await t.test(`HTTP ${status}`, async () => {
      const calls = [];
      const httpAdapter = mockAdapter(
        {
          [`${ORIGIN}/`]: {http_status: status, internal_links: ["/must-not-fetch"]},
          [`${ORIGIN}/must-not-fetch`]: {},
        },
        calls,
      );
      const output = await crawlSiteOutput(`${ORIGIN}/`, {
        httpAdapter,
        robotsPolicy: ALLOW_ALL_ROBOTS,
        maxPages: 5,
        concurrency: 1,
        now: fixedClock(),
      });

      assert.deepEqual(calls.map(({url}) => url), [`${ORIGIN}/`]);
      assert.equal(output.pages.length, 1);
      assert.equal(output.summary.halted_by_access_control.http_status, status);
      assert.ok(output.errors.some((error) => error.stage === "access_control"));
      assert.equal(output.discovered_urls.includes(`${ORIGIN}/must-not-fetch`), false);
    });
  }
});

test("standalone crawler outputs redact sensitive target query values", async () => {
  const target = `${ORIGIN}/?token=crawl-secret`;
  const options = {
    httpAdapter: async (url) => ({
      output: {
        requested_url: url,
        final_url: url,
        http_status: 200,
        content_type: "text/html",
        internal_links: [],
      },
      errors: [],
      status: "ok",
      observed_at: FIXED_TIMES[0],
    }),
    robotsPolicy: ALLOW_ALL_ROBOTS,
    now: fixedClock(),
  };

  const raw = await crawlSiteOutput(target, options);
  const result = await crawlSite(target, {...options, now: fixedClock()});

  assert.doesNotMatch(JSON.stringify(raw), /crawl-secret/);
  assert.doesNotMatch(JSON.stringify(result), /crawl-secret/);
  assert.match(decodeURIComponent(raw.target), /token=\[REDACTED\]/);
});
