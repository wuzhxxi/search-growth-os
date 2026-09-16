import test from "node:test";
import assert from "node:assert/strict";

import {
  createHttpAdapter,
  nodeHttpTransport,
} from "../lib/http/http-adapter.mjs";
import { DEFAULT_AUDIT_CONFIGURATION } from "../lib/audit/audit-run.mjs";
import { createDefaultAuditRunner } from "../lib/audit/default-runner.mjs";
import { startFixtureServer } from "./helpers/fixture-server.mjs";

const FIXED_TIME = "2026-09-15T00:00:00.000Z";
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];

function localLookup(_hostname, options, callback) {
  const done = typeof options === "function" ? options : callback;
  const lookupOptions = typeof options === "object" ? options : {};
  if (lookupOptions.all) {
    queueMicrotask(() => done(null, [{ address: "127.0.0.1", family: 4 }]));
  } else {
    queueMicrotask(() => done(null, "127.0.0.1", 4));
  }
}

test("real local fixture server exercises the full technical audit without public internet", async (t) => {
  const fixture = await startFixtureServer({
    "/robots.txt": {
      headers: { "content-type": "text/plain" },
      body: [
        "User-agent: *",
        "Allow: /",
        "Sitemap: https://public.example/sitemap.xml",
      ].join("\n"),
    },
    "/sitemap.xml": {
      headers: { "content-type": "application/xml" },
      body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://public.example/pages.xml</loc></sitemap>
      </sitemapindex>`,
    },
    "/pages.xml": {
      headers: { "content-type": "application/xml" },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://public.example/</loc></url>
        <url><loc>https://public.example/about</loc></url>
        <url><loc>https://public.example/orphan-candidate</loc></url>
      </urlset>`,
    },
    "/": {
      headers: { "content-type": "text/html", "x-robots-tag": "index, follow" },
      body: `<!doctype html><html><head>
        <title>Fixture home</title>
        <meta name="description" content="Fixture description">
        <link rel="canonical" href="https://public.example/">
        <link rel="alternate" hreflang="en" href="https://public.example/">
        <script type="application/ld+json">{"@type":"WebSite"}</script>
        </head><body>
        <a href="/about">About</a><a href="/missing">Missing</a>
        <a href="/redirect">Redirect</a><a href="/noindex">Noindex</a>
        </body></html>`,
    },
    "/about": {
      headers: { "content-type": "text/html" },
      body: "<title>About</title><link rel=canonical href=/preferred>",
    },
    "/missing": {
      status: 404,
      headers: { "content-type": "text/html" },
      body: "<title>Missing</title>",
    },
    "/redirect": {
      status: 301,
      headers: { location: "/final", "content-type": "text/plain" },
    },
    "/final": {
      headers: { "content-type": "text/html" },
      body: "<title>Final</title><link rel=canonical href=/final>",
    },
    "/noindex": {
      headers: { "content-type": "text/html" },
      body: "<title>Hidden</title><meta name=robots content=noindex>",
    },
  });
  t.after(fixture.close);

  const transportCalls = [];
  const transport = async (request) => {
    transportCalls.push({
      url: request.url.href,
      pinned: request.pinnedAddresses,
      userAgent: request.headers["user-agent"],
    });
    const mapped = new URL(`${request.url.pathname}${request.url.search}`, fixture.origin);
    return nodeHttpTransport({
      ...request,
      url: mapped,
      lookup: localLookup,
      headers: { ...request.headers, host: request.url.host },
    });
  };
  const httpAdapter = createHttpAdapter({
    transport,
    dnsLookup: PUBLIC_DNS,
    now: () => new Date(FIXED_TIME),
  });
  const run = createDefaultAuditRunner({
    httpAdapter,
    clock: () => new Date(FIXED_TIME),
    createRunId: () => "fixture-technical-run",
  });

  const audit = await run("technical", "https://public.example/", {
    max_pages: 10,
    concurrency: 2,
  });

  assert.equal(audit.run_id, "fixture-technical-run");
  assert.equal(audit.summary.status, "ok");
  assert.equal(audit.summary.pages_crawled, 5);
  assert.equal(audit.summary.sitemaps_checked, 2);
  assert.deepEqual(
    new Set(audit.tool_results.map(({ id }) => id)),
    new Set(["http", "robots", "sitemap", "bounded-technical-crawler"]),
  );
  assert.ok(audit.findings.some(({ title }) => title === "Internal URL returned HTTP 404"));
  assert.ok(audit.findings.some(({ title }) => title === "Crawled page declares noindex"));
  assert.ok(audit.findings.some(({ title }) => title.includes("orphan candidate")));
  assert.ok(transportCalls.length >= 8);
  assert.ok(transportCalls.every(({ url }) => url.startsWith("https://public.example/")));
  assert.ok(
    transportCalls.every(({ pinned }) => pinned[0].address === "93.184.216.34"),
  );
  assert.ok(transportCalls.every(
    ({ userAgent }) => userAgent === DEFAULT_AUDIT_CONFIGURATION.user_agent,
  ));
});

test("default crawl uses an exact robots product token while retaining its HTTP identity", async (t) => {
  const fixture = await startFixtureServer({
    "/robots.txt": {
      headers: { "content-type": "text/plain" },
      body: [
        "User-agent: SearchGrowthOS",
        "Disallow: /private",
        "",
        "User-agent: *",
        "Allow: /",
      ].join("\n"),
    },
    "/": {
      headers: { "content-type": "text/html" },
      body: [
        "<title>Robots identity fixture</title>",
        '<a href="/private">Private</a>',
        '<a href="/public">Public</a>',
        '<a href="/redirect-private">Redirect private</a>',
      ].join(""),
    },
    "/public": {
      headers: { "content-type": "text/html" },
      body: "<title>Public</title>",
    },
    "/redirect-private": {
      status: 302,
      headers: { location: "/private", "content-type": "text/plain" },
    },
    "/private": {
      status: 500,
      headers: { "content-type": "text/plain" },
      body: "This route must never be requested",
    },
  });
  t.after(fixture.close);

  const transportCalls = [];
  const transport = async (request) => {
    transportCalls.push({
      path: request.url.pathname,
      userAgent: request.headers["user-agent"],
    });
    const mapped = new URL(`${request.url.pathname}${request.url.search}`, fixture.origin);
    return nodeHttpTransport({
      ...request,
      url: mapped,
      lookup: localLookup,
      headers: { ...request.headers, host: request.url.host },
    });
  };
  const run = createDefaultAuditRunner({
    httpAdapter: createHttpAdapter({
      transport,
      dnsLookup: PUBLIC_DNS,
      now: () => new Date(FIXED_TIME),
    }),
    clock: () => new Date(FIXED_TIME),
    createRunId: () => "robots-product-token-run",
  });

  const audit = await run("crawl", "https://public.example/", {
    max_pages: 10,
    concurrency: 1,
  });
  const crawler = audit.tool_results.find(({ id }) => id === "bounded-technical-crawler");

  assert.equal(audit.configuration.robots_product_token, "SearchGrowthOS");
  assert.match(audit.configuration.user_agent, /^SearchGrowthOS\/0\.2\.0 \(/u);
  assert.notEqual(audit.configuration.user_agent, audit.configuration.robots_product_token);
  assert.deepEqual(
    transportCalls.map(({ path }) => path),
    ["/robots.txt", "/", "/public", "/redirect-private"],
  );
  assert.ok(transportCalls.every(
    ({ userAgent }) => userAgent === DEFAULT_AUDIT_CONFIGURATION.user_agent,
  ));
  assert.ok(crawler.output.pages.some(
    ({ requested_url: url }) => url === "https://public.example/public",
  ));
  assert.ok(crawler.output.skipped.some(({ url, status, reason }) =>
    url === "https://public.example/private" &&
    status === "blocked" &&
    reason === "matched_disallow"
  ));
  assert.ok(crawler.output.errors.some(({ url, status, stage }) =>
    url === "https://public.example/redirect-private" &&
    status === "blocked" &&
    stage === "http"
  ));
  assert.equal(transportCalls.some(({ path }) => path === "/private"), false);

  transportCalls.length = 0;
  const customUserAgent = "ExampleCrawler/1.0 (+https://example.com/bot)";
  const customHeaderAudit = await run("crawl", "https://public.example/", {
    max_pages: 10,
    concurrency: 1,
    user_agent: customUserAgent,
  });
  assert.equal(customHeaderAudit.configuration.user_agent, customUserAgent);
  assert.equal(customHeaderAudit.configuration.robots_product_token, "SearchGrowthOS");
  assert.deepEqual(
    transportCalls.map(({ path }) => path),
    ["/robots.txt", "/", "/public", "/redirect-private"],
  );
  assert.ok(transportCalls.every(({ userAgent }) => userAgent === customUserAgent));
  assert.equal(transportCalls.some(({ path }) => path === "/private"), false);
});
