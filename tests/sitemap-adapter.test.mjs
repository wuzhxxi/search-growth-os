import test from "node:test";
import assert from "node:assert/strict";
import {
  SITEMAP_ADAPTER,
  createSitemapAdapter,
  inspectSitemaps,
} from "../lib/sitemap/sitemap-adapter.mjs";

const NOW = "2026-09-15T00:00:00.000Z";

function httpResult(url, httpStatus, body, status = "ok") {
  return {
    id: "http",
    name: "HTTP adapter",
    version: "test",
    capabilities: ["http.inspect"],
    input: {url},
    output: {
      requested_url: url,
      final_url: url,
      http_status: httpStatus,
      content_type: url.endsWith(".txt") ? "text/plain" : "application/xml",
      raw: {body},
    },
    evidence: [],
    observed_at: NOW,
    status,
    errors: [],
  };
}

function routeAdapter(routes, requests = []) {
  return async ({url}) => {
    requests.push(url);
    const route = routes[new URL(url).pathname];
    if (!route) return httpResult(url, 404, "not found");
    return httpResult(url, route.status ?? 200, route.body, route.adapterStatus ?? "ok");
  };
}

test("sitemap adapter discovers robots declarations and /sitemap.xml, then traverses an index", async () => {
  const requests = [];
  const routes = {
    "/robots.txt": {
      body: "User-agent: *\nAllow: /\nSitemap: https://example.test/index.xml\n",
    },
    "/sitemap.xml": {
      body: "<urlset><url><loc>https://example.test/default</loc></url></urlset>",
    },
    "/index.xml": {
      body: "<sitemapindex><sitemap><loc>https://example.test/child.xml</loc></sitemap></sitemapindex>",
    },
    "/child.xml": {
      body: `<urlset>
        <url><loc>https://example.test/a</loc></url>
        <url><loc>https://example.test/b</loc></url>
      </urlset>`,
    },
  };
  const adapter = createSitemapAdapter({
    now: () => NOW,
    httpAdapter: routeAdapter(routes, requests),
  });
  const result = await adapter.inspect("https://example.test/products/one");

  assert.equal(result.status, "ok");
  assert.equal(result.id, SITEMAP_ADAPTER.id);
  assert.deepEqual(new Set(requests), new Set([
    "https://example.test/robots.txt",
    "https://example.test/index.xml",
    "https://example.test/sitemap.xml",
    "https://example.test/child.xml",
  ]));
  assert.equal(result.output.summary.sitemaps_checked, 3);
  assert.equal(result.output.summary.urls_discovered, 3);
  assert.deepEqual(new Set(result.output.urls), new Set([
    "https://example.test/default",
    "https://example.test/a",
    "https://example.test/b",
  ]));
  assert.equal(
    result.output.sitemaps.find(({url}) => url.endsWith("/index.xml")).type,
    "sitemapindex",
  );
});

test("sitemap traversal detects a nested cycle without refetching it", async () => {
  const requests = [];
  const routes = {
    "/a.xml": {
      body: "<sitemapindex><sitemap><loc>https://example.test/b.xml</loc></sitemap></sitemapindex>",
    },
    "/b.xml": {
      body: "<sitemapindex><sitemap><loc>https://example.test/a.xml</loc></sitemap></sitemapindex>",
    },
  };
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: ["https://example.test/a.xml"],
      includeDefault: false,
      maxDepth: 5,
    },
    {now: () => NOW, httpAdapter: routeAdapter(routes, requests)},
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(requests, [
    "https://example.test/a.xml",
    "https://example.test/b.xml",
  ]);
  assert.equal(result.output.summary.cycles_skipped, 1);
  assert.ok(result.errors.some(({details}) => details?.kind === "SITEMAP_CYCLE"));
});

test("sitemap traversal enforces depth before fetching nested documents", async () => {
  const requests = [];
  const routes = {
    "/index.xml": {
      body: "<sitemapindex><sitemap><loc>https://example.test/child.xml</loc></sitemap></sitemapindex>",
    },
    "/child.xml": {
      body: "<urlset><url><loc>https://example.test/a</loc></url></urlset>",
    },
  };
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: ["https://example.test/index.xml"],
      includeDefault: false,
      maxDepth: 0,
    },
    {now: () => NOW, httpAdapter: routeAdapter(routes, requests)},
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(requests, ["https://example.test/index.xml"]);
  assert.equal(result.output.summary.depth_limits_hit, 1);
  assert.equal(result.output.summary.sitemaps_checked, 1);
});

test("sitemap traversal enforces the aggregate URL bound", async () => {
  const routes = {
    "/map.xml": {
      body: `<urlset>
        <url><loc>https://example.test/a</loc></url>
        <url><loc>https://example.test/b</loc></url>
      </urlset>`,
    },
  };
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: ["https://example.test/map.xml"],
      includeDefault: false,
      maxUrls: 1,
    },
    {now: () => NOW, httpAdapter: routeAdapter(routes)},
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(result.output.urls, ["https://example.test/a"]);
  assert.equal(result.output.summary.url_limit_hit, true);
  assert.ok(
    result.output.sitemaps[0].parse_errors.some(
      ({code}) => code === "SITEMAP_ENTRY_LIMIT",
    ),
  );
});

test("sitemap adapter rejects credential-bearing targets before discovery", async () => {
  let called = false;
  const result = await inspectSitemaps(
    "https://user:secret@example.test/",
    {},
    {
      httpAdapter: async () => {
        called = true;
      },
    },
  );
  assert.equal(result.status, "invalid");
  assert.equal(called, false);
});

test("provided sitemap declarations are bounded and credential details are redacted", async () => {
  const credentialUrl = "https://user:declaration-secret@example.test/map.xml";
  const supplied = [
    credentialUrl,
    ...Array.from({length: 100}, (_, index) => `https://example.test/map-${index}.xml`),
  ];
  const requests = [];
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: supplied,
      includeDefault: false,
      maxSitemaps: 1,
    },
    {now: () => NOW, httpAdapter: routeAdapter({}, requests)},
  );

  assert.equal(result.output.discovery.robots_sitemaps.length, 100);
  assert.equal(requests.length, 1);
  assert.ok(
    result.errors.some(({details}) => details?.kind === "SITEMAP_DECLARATION_LIMIT"),
  );
  assert.doesNotMatch(JSON.stringify(result), /declaration-secret/);
});

test("partial HTTP bytes are not parsed as a sitemap", async () => {
  const requests = [];
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: ["https://example.test/map.xml"],
      includeDefault: false,
    },
    {
      now: () => NOW,
      httpAdapter: routeAdapter({
        "/map.xml": {
          body: "<urlset><url><loc>https://example.test/a</loc></url></urlset>",
          adapterStatus: "partial",
        },
      }, requests),
    },
  );

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.output.urls, []);
  assert.ok(
    result.errors.some(({details}) => details?.kind === "SITEMAP_HTTP_PARTIAL"),
  );
});

test("sitemap traversal blocks cross-origin children without requesting them", async () => {
  const requests = [];
  const routes = {
    "/index.xml": {
      body: `<sitemapindex>
        <sitemap><loc>https://other.test/private.xml</loc></sitemap>
      </sitemapindex>`,
    },
  };
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: ["https://example.test/index.xml"],
      includeDefault: false,
    },
    {now: () => NOW, httpAdapter: routeAdapter(routes, requests)},
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(requests, ["https://example.test/index.xml"]);
  assert.ok(
    result.errors.some(
      ({details}) => details?.kind === "SITEMAP_CROSS_ORIGIN_BLOCKED",
    ),
  );
});

test("sitemap traversal stops the queue after an HTTP 429", async () => {
  const requests = [];
  const result = await inspectSitemaps(
    "https://example.test/",
    {
      robotsSitemaps: [
        "https://example.test/rate-limited.xml",
        "https://example.test/must-not-fetch.xml",
      ],
      includeDefault: false,
    },
    {
      now: () => NOW,
      httpAdapter: routeAdapter({
        "/rate-limited.xml": {status: 429, body: "slow down"},
        "/must-not-fetch.xml": {
          body: "<urlset><url><loc>https://example.test/leaked</loc></url></urlset>",
        },
      }, requests),
    },
  );

  assert.deepEqual(requests, ["https://example.test/rate-limited.xml"]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.output.summary.rate_limited, true);
  assert.ok(result.errors.some(({details}) => details?.kind === "HTTP_RATE_LIMITED"));
});

test("robots discovery HTTP 429 prevents the default sitemap request", async () => {
  const requests = [];
  const result = await inspectSitemaps(
    "https://example.test/",
    {},
    {
      now: () => NOW,
      httpAdapter: routeAdapter({
        "/robots.txt": {status: 429, body: "slow down"},
        "/sitemap.xml": {
          body: "<urlset><url><loc>https://example.test/leaked</loc></url></urlset>",
        },
      }, requests),
    },
  );

  assert.deepEqual(requests, ["https://example.test/robots.txt"]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.output.summary.rate_limited, true);
});

test("sitemap adapter rejects limits above hard caps before HTTP", async () => {
  const configurations = [
    {maxDepth: 6},
    {maxSitemaps: 101},
    {maxUrls: 100_001},
    {maxBodyBytes: 5 * 1024 * 1024 + 1},
    {sampleLimit: 101},
  ];

  for (const config of configurations) {
    let called = false;
    const result = await inspectSitemaps(
      "https://example.test/",
      config,
      {
        httpAdapter: async () => {
          called = true;
        },
      },
    );
    assert.equal(result.status, "invalid", JSON.stringify(config));
    assert.equal(called, false, JSON.stringify(config));
  }
});
