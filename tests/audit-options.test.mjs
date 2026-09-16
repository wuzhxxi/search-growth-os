import test from "node:test";
import assert from "node:assert/strict";

import { parseAuditOptions } from "../lib/cli/audit-options.mjs";

test("audit options parse JSON and bounded numeric configuration", () => {
  assert.deepEqual(
    parseAuditOptions([
      "https://example.com",
      "--json",
      "--max-pages=12",
      "--concurrency",
      "3",
    ]),
    {
      positionals: ["https://example.com"],
      configuration: { max_pages: 12, concurrency: 3 },
      json: true,
      help: false,
    },
  );
});

test("audit options reject unknown, missing, fractional, and out-of-range values", () => {
  assert.throws(() => parseAuditOptions(["--unknown", "1"]), /Unknown option/);
  assert.throws(() => parseAuditOptions(["--max-pages"]), /integer/);
  assert.throws(() => parseAuditOptions(["--max-pages", "1.5"]), /integer/);
  assert.throws(() => parseAuditOptions(["--concurrency", "11"]), /between 1 and 10/);
  assert.throws(() => parseAuditOptions(["--max-links-per-page", "501"]), /between 1 and 500/);
});
