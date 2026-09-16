import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PARSE_ERRORS,
  parseSitemapXml,
} from "../lib/sitemap/sitemap-parser.mjs";

test("sitemap parser reads a namespace urlset and decodes XML entities", () => {
  const parsed = parseSitemapXml(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.test/a?x=1&amp;y=2</loc></url>
      <url><loc><![CDATA[https://example.test/b?x=1&y=2]]></loc></url>
    </urlset>`);

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.type, "urlset");
  assert.equal(parsed.url_count, 2);
  assert.equal(parsed.child_sitemap_count, 0);
  assert.deepEqual(parsed.urls, [
    "https://example.test/a?x=1&y=2",
    "https://example.test/b?x=1&y=2",
  ]);
});

test("sitemap parser reads sitemap indexes without counting children as page URLs", () => {
  const parsed = parseSitemapXml(`
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.test/a.xml</loc></sitemap>
      <sitemap><loc>https://example.test/b.xml</loc></sitemap>
    </sitemapindex>`);

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.type, "sitemapindex");
  assert.equal(parsed.url_count, 0);
  assert.equal(parsed.child_sitemap_count, 2);
  assert.deepEqual(parsed.child_sitemaps, [
    "https://example.test/a.xml",
    "https://example.test/b.xml",
  ]);
  assert.deepEqual(parsed.sample_urls, parsed.child_sitemaps);
});

test("sitemap parser reports malformed XML instead of guessing missing entries", () => {
  const parsed = parseSitemapXml(
    "<urlset><url><loc>https://example.test/a</loc></urlset>",
  );

  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.url_count, 0);
  assert.ok(
    parsed.parse_errors.some(({code}) => code === "SITEMAP_ENTRY_TAG_MISMATCH"),
  );
});

test("sitemap parser enforces entry and body limits", () => {
  const xml = `<urlset>
    <url><loc>https://example.test/a</loc></url>
    <url><loc>https://example.test/b</loc></url>
  </urlset>`;
  const limited = parseSitemapXml(xml, {maxUrls: 1});
  assert.equal(limited.status, "partial");
  assert.equal(limited.url_count, 1);
  assert.equal(limited.truncated, true);
  assert.ok(limited.parse_errors.some(({code}) => code === "SITEMAP_ENTRY_LIMIT"));

  const oversized = parseSitemapXml(xml, {maxBodyBytes: 10});
  assert.equal(oversized.status, "invalid");
  assert.equal(oversized.parse_errors[0].code, "SITEMAP_BODY_TOO_LARGE");
});

test("sitemap parser refuses DTD/entity declarations", () => {
  const parsed = parseSitemapXml(
    '<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset></urlset>',
  );
  assert.equal(parsed.status, "invalid");
  assert.equal(parsed.parse_errors[0].code, "SITEMAP_DTD_UNSUPPORTED");
});

test("sitemap parser rejects credential-bearing loc values without retaining secrets", () => {
  const secret = "do-not-record-this-password";
  const parsed = parseSitemapXml(
    `<urlset><url><loc>https://user:${secret}@example.test/private</loc></url></urlset>`,
  );

  assert.equal(parsed.status, "partial");
  assert.deepEqual(parsed.urls, []);
  assert.ok(parsed.parse_errors.some(({code}) => code === "SITEMAP_LOC_INVALID"));
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret));
});

test("sitemap parser handles a large malformed tag stream in bounded time", () => {
  const xml = `<urlset>${"<url".repeat(10_000)}</urlset>`;
  const startedAt = performance.now();
  const parsed = parseSitemapXml(xml);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(parsed.status, "invalid");
  assert.ok(
    parsed.parse_errors.some(({code}) => code === "SITEMAP_TAG_UNCLOSED"),
  );
  assert.ok(elapsedMs < 1_500, `sitemap parsing took ${elapsedMs.toFixed(1)}ms`);
});

test("sitemap parser caps diagnostics from adversarial invalid entries", () => {
  const entries = Array.from(
    {length: MAX_PARSE_ERRORS + 25},
    (_, index) => `<url><loc>not-a-url-${index}</loc></url>`,
  ).join("");
  const parsed = parseSitemapXml(`<urlset>${entries}</urlset>`);

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.parse_errors_truncated, true);
  assert.ok(parsed.parse_errors.length <= MAX_PARSE_ERRORS);
  assert.equal(parsed.parse_error_count, parsed.parse_errors.length);
});

test("sitemap parser rejects configuration above hard limits", () => {
  const xml = "<urlset></urlset>";
  const oversizedBodyLimit = parseSitemapXml(xml, {maxBodyBytes: 5 * 1024 * 1024 + 1});
  const oversizedEntryLimit = parseSitemapXml(xml, {maxUrls: 100_001});
  const oversizedSampleLimit = parseSitemapXml(xml, {sampleLimit: 101});

  for (const parsed of [oversizedBodyLimit, oversizedEntryLimit, oversizedSampleLimit]) {
    assert.equal(parsed.status, "invalid");
    assert.equal(parsed.parse_errors[0].code, "SITEMAP_LIMIT_INVALID");
  }
});
