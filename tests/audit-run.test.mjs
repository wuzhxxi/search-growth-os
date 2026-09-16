import test from "node:test";
import assert from "node:assert/strict";

import {
  createAuditRunner,
  DEFAULT_AUDIT_CONFIGURATION,
} from "../lib/audit/audit-run.mjs";

const timestamp = "2026-09-15T00:00:00.000Z";

function result(id, output = {}, overrides = {}) {
  return {
    id,
    name: id,
    version: "0.2.0",
    capabilities: [id],
    input: { url: "https://example.com/" },
    output,
    evidence: [
      {
        state: "OBSERVED",
        source: "https://example.com/",
        observed_at: timestamp,
        notes: `${id} observed fixture data`,
      },
    ],
    observed_at: timestamp,
    errors: [],
    status: "ok",
    ...overrides,
  };
}

test("technical audit produces a provenance-preserving structured run", async () => {
  const calls = [];
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-fixture",
    http: async () => {
      calls.push("http");
      return result("http", {
        requested_url: "https://example.com/",
        final_url: "https://example.com/",
        http_status: 200,
        redirect_chain: [],
        meta_robots: [],
      });
    },
    robots: async (_target, context) => {
      calls.push("robots");
      assert.equal(context.http_result.id, "http");
      return result("robots", { sitemap_urls: ["https://example.com/sitemap.xml"] });
    },
    sitemap: async (_target, context) => {
      calls.push("sitemap");
      assert.equal(context.robots_result.id, "robots");
      return result("sitemap", {
        urls: ["https://example.com/", "https://example.com/unlinked"],
        sitemaps: [
          {
            sitemap_url: "https://example.com/sitemap.xml",
            parse_errors: [],
          },
        ],
      });
    },
    crawler: async (_target, context) => {
      calls.push("crawler");
      assert.equal(context.sitemap_result.id, "sitemap");
      return result("crawler", {
        pages: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            status: 200,
            internal_links: [],
            discovered_from: [],
          },
        ],
      });
    },
  });

  const audit = await run("technical", "https://example.com/", { max_pages: 5 });
  assert.deepEqual(calls, ["http", "robots", "sitemap", "crawler"]);
  assert.equal(audit.run_id, "run-fixture");
  assert.equal(audit.timestamp, timestamp);
  assert.equal(audit.configuration.max_pages, 5);
  assert.equal(audit.configuration.timeout_ms, DEFAULT_AUDIT_CONFIGURATION.timeout_ms);
  assert.deepEqual(audit.adapter_versions, {
    http: "0.2.0",
    robots: "0.2.0",
    sitemap: "0.2.0",
    crawler: "0.2.0",
  });
  assert.equal(audit.tool_results.length, 4);
  assert.equal(audit.evidence.length, 4);
  assert.equal(audit.summary.status, "ok");
  assert.equal(audit.summary.pages_crawled, 1);
  assert.equal(audit.summary.sitemaps_checked, 1);
  const candidate = audit.findings.find((finding) => finding.title.includes("orphan candidate"));
  assert.ok(candidate);
  assert.equal(candidate.evidence[0].state, "INFERRED");
});

test("blocked target remains explicit and stops the technical pipeline", async () => {
  let downstreamCalls = 0;
  const blocked = result("http", null, {
    status: "blocked",
    evidence: [],
    errors: [{ code: "FORBIDDEN_IP", status: "blocked", message: "Private IP blocked" }],
  });
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-blocked",
    http: async () => blocked,
    robots: async () => { downstreamCalls += 1; },
    sitemap: async () => { downstreamCalls += 1; },
    crawler: async () => { downstreamCalls += 1; },
  });

  const audit = await run("technical", "http://127.0.0.1/");
  assert.equal(downstreamCalls, 0);
  assert.equal(audit.summary.status, "blocked");
  assert.equal(audit.errors[0].code, "blocked");
  assert.equal(audit.tool_results[0].status, "blocked");
});

test("technical audit stops all downstream requests after a root HTTP 429", async () => {
  const calls = [];
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-rate-limited",
    http: async () => {
      calls.push("http");
      return result("http", {
        requested_url: "https://example.com/",
        final_url: "https://example.com/",
        http_status: 429,
        redirect_chain: [],
      });
    },
    robots: async () => { calls.push("robots"); },
    sitemap: async () => { calls.push("sitemap"); },
    crawler: async () => { calls.push("crawler"); },
  });

  const audit = await run("technical", "https://example.com/");
  assert.deepEqual(calls, ["http"]);
  assert.equal(audit.summary.status, "partial");
  assert.ok(audit.errors.some(({code}) => code === "HTTP_RATE_LIMITED"));
});

test("crawl is conservatively skipped when robots collection times out", async () => {
  let crawlCalled = false;
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-timeout",
    robots: async () => result("robots", null, {
      status: "timeout",
      evidence: [],
      errors: [{ code: "ROBOTS_TIMEOUT", status: "timeout", message: "Timed out" }],
    }),
    crawler: async () => { crawlCalled = true; },
  });

  const audit = await run("crawl", "https://example.com/");
  assert.equal(crawlCalled, false);
  assert.equal(audit.summary.status, "timeout");
  assert.ok(audit.errors.some((error) => error.adapter === "crawler"));
});

test("standalone commands preserve a failing primary adapter status", async () => {
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-primary-blocked",
    robots: async () => result("robots", {evaluations: []}),
    crawler: async () => result("crawler", null, {
      status: "blocked",
      evidence: [],
      errors: [{code: "ACCESS_BLOCKED", status: "blocked", message: "Denied"}],
    }),
  });

  const audit = await run("crawl", "https://example.com/");
  assert.equal(audit.summary.status, "blocked");
});

test("robots product token is explicit and validated independently of the HTTP User-Agent", async () => {
  let adapterCalls = 0;
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-custom-identity",
    robots: async (_target, {configuration}) => {
      adapterCalls += 1;
      assert.equal(configuration.user_agent, "ExampleCrawler/1.0 (+https://example.com/bot)");
      assert.equal(configuration.robots_product_token, "ExampleCrawler");
      return result("robots", {evaluations: []});
    },
  });

  const audit = await run("robots", "https://example.com/", {
    user_agent: "ExampleCrawler/1.0 (+https://example.com/bot)",
    robots_product_token: "ExampleCrawler",
  });
  assert.equal(audit.summary.status, "ok");
  assert.equal(adapterCalls, 1);

  await assert.rejects(
    run("robots", "https://example.com/", {
      robots_product_token: "ExampleCrawler/1.0",
    }),
    /robots_product_token must be 1-512 ASCII letters, underscores, or hyphens/u,
  );
  assert.equal(adapterCalls, 1);
});

test("Audit Run caps amplified findings and records the truncation", async () => {
  const pages = Array.from({length: 600}, (_, index) => ({
    url: `https://example.com/missing-${index}`,
    final_url: `https://example.com/missing-${index}`,
    status: 404,
    internal_links: [],
    discovered_from: ["https://example.com/"],
    observed_at: timestamp,
  }));
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-finding-cap",
    robots: async () => result("robots", {evaluations: []}),
    crawler: async () => result("crawler", {pages}),
  });

  const audit = await run("crawl", "https://example.com/");
  assert.equal(audit.findings.length, 500);
  assert.equal(audit.summary.finding_count, 500);
  assert.equal(audit.summary.status, "partial");
  assert.ok(audit.errors.some((error) => error.code === "AUDIT_FINDING_LIMIT_REACHED"));
});

test("Audit Run redacts credential and sensitive-query secrets from every serialized field", async () => {
  const target = "https://user:run-secret@example.com/path?token=query-secret";
  const blocked = result("http", null, {
    status: "blocked",
    input: {url: target},
    evidence: [],
    errors: [{
      code: "URL_CREDENTIALS_BLOCKED",
      status: "blocked",
      message: `Credentials rejected for ${target}`,
      url: target,
    }],
  });
  const run = createAuditRunner({
    clock: () => new Date(timestamp),
    createRunId: () => "run-redacted",
    http: async () => blocked,
  });

  const audit = await run("technical", target);
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /run-secret|query-secret/);
  assert.doesNotMatch(audit.target, /user:/);
  assert.match(decodeURIComponent(audit.target), /token=\[REDACTED\]/);
});
