import test from "node:test";
import assert from "node:assert/strict";
import {
  CRAWLER_REGISTRY,
  SUPPORTED_CRAWLERS,
  evaluateRobotsPolicy,
  isPathAllowed,
  parseRobotsTxt,
} from "../lib/robots/robots-parser.mjs";

test("robots parser preserves groups, rules, and unique sitemap declarations", () => {
  const parsed = parseRobotsTxt(`
    Sitemap: https://example.test/sitemap.xml
    sitemap: https://example.test/sitemap.xml # duplicate
    User-agent: Googlebot
    User-agent: OAI-SearchBot
    Disallow: /private
    Allow: /private/public

    User-agent: *
    Disallow: /tmp
  `);

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].user_agents, ["Googlebot", "OAI-SearchBot"]);
  assert.deepEqual(parsed.groups[0].allow, ["/private/public"]);
  assert.deepEqual(parsed.groups[0].disallow, ["/private"]);
  assert.deepEqual(parsed.sitemaps, ["https://example.test/sitemap.xml"]);
});

test("robots evaluation selects the most specific rule and lets Allow win a tie", () => {
  const parsed = parseRobotsTxt(`
    User-agent: *
    Disallow: /
    User-agent: GPTBot
    Disallow: /docs/*
    Disallow: /docs/public$
    Allow: /docs/public$
  `);

  const exact = evaluateRobotsPolicy(parsed, "GPTBot", "/docs/public");
  const child = evaluateRobotsPolicy(parsed, "GPTBot", "/docs/public/child");
  assert.equal(exact.allowed, true);
  assert.equal(exact.matched_rule.directive, "allow");
  assert.equal(child.allowed, false);
  assert.equal(child.matched_rule.directive, "disallow");
  assert.equal(isPathAllowed(parsed, "ClaudeBot", "/anything"), false);
  assert.match(exact.caution, /does not guarantee/i);
});

test("Googlebot Smartphone is evaluated with the Googlebot robots token", () => {
  const parsed = parseRobotsTxt(`
    User-agent: Googlebot
    Disallow: /mobile-private
    User-agent: Googlebot-Smartphone
    Allow: /
  `);
  const evaluation = evaluateRobotsPolicy(
    parsed,
    "Googlebot Smartphone",
    "/mobile-private",
  );

  assert.equal(evaluation.robots_token, "Googlebot");
  assert.equal(evaluation.allowed, false);
  assert.deepEqual(evaluation.matched_group_indexes, [0]);
});

test("crawler registry is sourced, dated, mutable metadata rather than policy code", () => {
  assert.deepEqual(SUPPORTED_CRAWLERS, [
    "Googlebot",
    "Googlebot Smartphone",
    "OAI-SearchBot",
    "GPTBot",
    "ChatGPT-User",
    "Claude-SearchBot",
    "ClaudeBot",
    "Claude-User",
    "PerplexityBot",
  ]);
  for (const crawler of CRAWLER_REGISTRY.crawlers) {
    for (const field of ["crawler", "purpose", "source", "last_verified", "status"]) {
      assert.equal(typeof crawler[field], "string", `${crawler.crawler}.${field}`);
      assert.ok(crawler[field].length > 0, `${crawler.crawler}.${field}`);
    }
    assert.match(crawler.source, /^https:\/\//);
  }
  assert.match(CRAWLER_REGISTRY.notes.join(" "), /recheck/i);
  assert.doesNotMatch(
    CRAWLER_REGISTRY.crawlers.find(({crawler}) => crawler === "GPTBot").purpose,
    /ChatGPT Search/i,
  );
});

test("robots parser reports malformed and oversized input explicitly", () => {
  const malformed = parseRobotsTxt("Disallow: /secret\nnot-a-directive");
  assert.equal(malformed.status, "partial");
  assert.deepEqual(
    malformed.parse_errors.map(({code}) => code),
    ["ROBOTS_RULE_WITHOUT_AGENT", "ROBOTS_DIRECTIVE_MALFORMED"],
  );

  const oversized = parseRobotsTxt("12345", {maxBytes: 4});
  assert.equal(oversized.status, "invalid");
  assert.equal(oversized.parse_errors[0].code, "ROBOTS_BODY_TOO_LARGE");
});

test("robots matching decodes unreserved octets but preserves reserved octets", () => {
  const parsed = parseRobotsTxt(`
    User-agent: *
    Disallow: /private
    Disallow: /a/b
  `);

  const unreserved = evaluateRobotsPolicy(parsed, "GPTBot", "/%70rivate");
  const reserved = evaluateRobotsPolicy(parsed, "GPTBot", "/a%2Fb");

  assert.equal(unreserved.allowed, false);
  assert.equal(unreserved.path, "/private");
  assert.equal(reserved.allowed, true);
  assert.equal(reserved.path, "/a%2Fb");
});

test("robots wildcard matching remains bounded for pathological patterns", () => {
  const parsed = parseRobotsTxt(`
    User-agent: *
    Disallow: /${"*a".repeat(900)}b$
  `);
  const startedAt = performance.now();
  const evaluation = evaluateRobotsPolicy(
    parsed,
    "GPTBot",
    `/${"a".repeat(2_000)}c`,
  );
  const elapsedMs = performance.now() - startedAt;

  assert.equal(evaluation.status, "evaluated");
  assert.equal(evaluation.allowed, true);
  assert.ok(elapsedMs < 1_500, `robots matching took ${elapsedMs.toFixed(1)}ms`);
});

test("robots parser enforces the directive hard cap", () => {
  const parsed = parseRobotsTxt(
    "User-agent: *\nAllow: /\nDisallow: /private\n",
    {maxDirectives: 2},
  );

  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.groups.length, 0);
  assert.ok(
    parsed.parse_errors.some(({code}) => code === "ROBOTS_DIRECTIVE_LIMIT"),
  );
});
