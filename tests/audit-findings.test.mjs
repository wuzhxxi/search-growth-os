import test from "node:test";
import assert from "node:assert/strict";

import {
  findingsFromCrawler,
  findingsFromHttp,
  findingsFromRobots,
  findingsFromSitemaps,
} from "../lib/audit/findings.mjs";
import { formatAuditRun } from "../lib/audit/format.mjs";

const observedAt = "2026-09-15T00:00:00.000Z";

test("HTTP findings preserve observations without inventing business impact", () => {
  const findings = findingsFromHttp({
    observed_at: observedAt,
    output: {
      requested_url: "https://example.com/old",
      final_url: "https://example.com/missing",
      http_status: 404,
      redirect_chain: [{ status: 301 }, { status: 302 }],
      canonical: "https://example.com/canonical",
      meta_robots: ["noindex,follow"],
    },
  });

  assert.deepEqual(
    new Set(findings.map((finding) => finding.title)),
    new Set([
      "Target returned HTTP 404",
      "Target uses a multi-hop redirect chain",
      "Target declares meta robots noindex",
      "Declared canonical differs from the final URL",
    ]),
  );
  assert.ok(findings.every((finding) => finding.agent === "aeo"));
  assert.ok(findings.every((finding) => finding.evidence[0].state === "OBSERVED"));
  assert.doesNotMatch(JSON.stringify(findings), /\b20%\b|guarantee|guaranteed/i);
  assert.match(JSON.stringify(findings), /UNKNOWN/);
});

test("crawler only labels an unobserved sitemap URL as a scoped orphan candidate", () => {
  const findings = findingsFromCrawler(
    {
      observed_at: observedAt,
      output: {
        pages: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            status: 200,
            internal_links: ["https://example.com/about"],
            discovered_from: [],
          },
          {
            url: "https://example.com/about",
            final_url: "https://example.com/about",
            status: 200,
            internal_links: [],
            discovered_from: ["https://example.com/"],
          },
        ],
      },
    },
    {
      sitemapUrls: [
        "https://example.com/about",
        "https://example.com/sitemap-only",
      ],
    },
  );

  const candidate = findings.find((finding) => finding.title.includes("orphan candidate"));
  assert.ok(candidate);
  assert.deepEqual(candidate.affected_assets, ["https://example.com/sitemap-only"]);
  assert.equal(candidate.confidence, "low");
  assert.equal(candidate.evidence[0].state, "INFERRED");
  assert.match(candidate.evidence[0].notes, /does not prove/i);
});

test("orphan candidate findings are capped with an explicit summary", () => {
  const sitemapUrls = Array.from(
    {length: 250},
    (_, index) => `https://example.com/sitemap-only-${index}`,
  );
  const findings = findingsFromCrawler(
    {
      observed_at: observedAt,
      output: {
        pages: [
          {
            url: "https://example.com/",
            final_url: "https://example.com/",
            status: 200,
            internal_links: [],
            discovered_from: [],
          },
        ],
      },
    },
    {sitemapUrls},
  );

  assert.equal(findings.length, 101);
  assert.equal(
    findings.filter((finding) => finding.title.includes("orphan candidate in")).length,
    100,
  );
  const summary = findings.find((finding) => finding.title.includes("were omitted"));
  assert.ok(summary);
  assert.match(summary.evidence[0].notes, /150 additional sitemap URLs/);
});

test("sitemap parse errors become evidence-backed findings", () => {
  const [finding] = findingsFromSitemaps({
    observed_at: observedAt,
    output: {
      sitemaps: [
        {
          sitemap_url: "https://example.com/sitemap.xml",
          parse_errors: ["Malformed XML"],
        },
      ],
    },
  });
  assert.equal(finding.evidence[0].state, "OBSERVED");
  assert.match(finding.evidence[0].notes, /Malformed XML/);
});

test("robots findings report disallow observations without promising search outcomes", () => {
  const [finding] = findingsFromRobots({
    input: { target_url: "https://example.com/private" },
    observed_at: observedAt,
    output: {
      robots_url: "https://example.com/robots.txt",
      evaluations: [
        {
          crawler: "Googlebot",
          allowed: false,
          robots_policy_applicability: "applies",
        },
        {
          crawler: "ChatGPT-User",
          allowed: false,
          robots_policy_applicability: "may_not_apply",
        },
      ],
    },
  });
  assert.equal(finding.evidence[0].state, "OBSERVED");
  assert.match(finding.evidence[0].notes, /Googlebot/);
  assert.match(finding.evidence[0].notes, /may_not_apply/);
  assert.match(finding.business_impact, /do not by themselves prove indexing/);
  assert.doesNotMatch(finding.business_impact, /guarantee/i);
});

test("terminal formatter surfaces run provenance and limitations", () => {
  const text = formatAuditRun({
    run_id: "run-1",
    kind: "technical",
    target: "https://example.com/",
    timestamp: observedAt,
    summary: {
      status: "partial",
      evidence_count: 2,
      finding_count: 0,
      error_count: 1,
      pages_crawled: 1,
      sitemaps_checked: 1,
    },
    findings: [],
    errors: [{ code: "timeout", adapter: "http", message: "Timed out" }],
  });
  assert.match(text, /Run: run-1/);
  assert.match(text, /Errors \/ unavailable evidence/);
  assert.match(text, /does not establish ranking, citation, traffic, or conversion impact/);
});
