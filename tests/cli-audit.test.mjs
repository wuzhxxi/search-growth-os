import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function cli(...args) {
  return spawnSync(process.execPath, ["scripts/search-growth.mjs", ...args], {
    encoding: "utf8",
  });
}

test("CLI advertises the Phase 2A technical commands", () => {
  const result = cli("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /audit technical <URL>/);
  assert.match(result.stdout, /audit robots <URL>/);
  assert.match(result.stdout, /audit sitemap <URL>/);
  assert.match(result.stdout, /crawl <URL>/);
  assert.match(result.stdout, /--json/);
});

test("audit help is a successful command", () => {
  const result = cli("audit", "--help");
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /audit technical <URL>/);
});

test("CLI JSON output preserves a blocked private target as structured UNKNOWN evidence", () => {
  const result = cli("audit", "technical", "http://127.0.0.1/", "--json");
  assert.notEqual(result.status, 0);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.kind, "technical");
  assert.equal(audit.summary.status, "blocked");
  assert.equal(audit.tool_results[0].status, "blocked");
  assert.equal(audit.evidence[0].state, "UNKNOWN");
  assert.equal(audit.evidence[0].observed_at, null);
  assert.match(audit.errors[0].message, /non-public IP/i);
});

test("CLI rejects invalid schemes and unsafe option ranges without network access", () => {
  const scheme = cli("audit", "robots", "file:///etc/passwd", "--json");
  assert.notEqual(scheme.status, 0);
  assert.equal(JSON.parse(scheme.stdout).summary.status, "invalid");

  const option = cli("crawl", "https://example.com/", "--concurrency", "11");
  assert.notEqual(option.status, 0);
  assert.match(option.stderr, /between 1 and 10/);
  assert.equal(option.stdout, "");
});

test("CLI JSON never echoes URL credentials or sensitive query values", () => {
  const result = cli(
    "audit",
    "technical",
    "https://user:cli-secret@example.com/path?token=query-secret",
    "--json",
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /cli-secret|query-secret/);
  const audit = JSON.parse(result.stdout);
  assert.equal(audit.summary.status, "blocked");
  assert.doesNotMatch(audit.target, /user:/);
  assert.match(decodeURIComponent(audit.target), /token=\[REDACTED\]/);
});

test("unknown commands redact sensitive URL arguments", () => {
  const result = cli(
    "audit",
    "typo",
    "https://user:unknown-secret@example.com/?token=query-secret",
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /unknown-secret|query-secret/);
  assert.match(decodeURIComponent(result.stderr), /\[REDACTED\]/);
});
