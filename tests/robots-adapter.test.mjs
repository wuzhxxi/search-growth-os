import test from "node:test";
import assert from "node:assert/strict";
import {
  ROBOTS_ADAPTER,
  createRobotsAdapter,
  inspectRobots,
} from "../lib/robots/robots-adapter.mjs";

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
      content_type: "text/plain",
      raw: {body},
    },
    evidence: [],
    observed_at: NOW,
    status,
    errors: [],
  };
}

test("robots adapter fetches origin robots.txt and evaluates every registry crawler", async () => {
  const requests = [];
  const adapter = createRobotsAdapter({
    now: () => NOW,
    httpAdapter: async (input) => {
      requests.push(input);
      return httpResult(
        input.url,
        200,
        "User-agent: OAI-SearchBot\nDisallow: /private\nSitemap: https://example.test/map.xml\n",
      );
    },
  });

  const result = await adapter.inspect("https://example.test/private?view=1");
  assert.equal(result.status, "ok");
  assert.equal(result.observed_at, NOW);
  assert.equal(requests[0].url, "https://example.test/robots.txt");
  assert.equal(result.output.file_status, "present");
  assert.deepEqual(result.output.sitemaps, ["https://example.test/map.xml"]);
  assert.equal(result.output.evaluations.length, 9);
  assert.equal(
    result.output.evaluations.find(({crawler}) => crawler === "OAI-SearchBot").allowed,
    false,
  );
  assert.equal(result.output.raw.body_sha256.length, 64);
  assert.equal(result.id, ROBOTS_ADAPTER.id);
});

test("an observed 404 means no robots file and evaluates as allowed by absence", async () => {
  const result = await inspectRobots(
    "https://example.test/path",
    {},
    {
      now: () => NOW,
      httpAdapter: async ({url}) => httpResult(url, 404, "not found"),
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.output.file_status, "absent");
  assert.equal(result.output.groups.length, 0);
  assert.ok(result.output.evaluations.every(({allowed}) => allowed === true));
  assert.ok(
    result.output.evaluations.every(({reason}) => reason === "robots_file_absent"),
  );
});

test("robots adapter preserves an upstream blocked status and diagnostic code", async () => {
  const result = await inspectRobots(
    "https://127.0.0.1/",
    {},
    {
      now: () => NOW,
      httpAdapter: async ({url}) => ({
        ...httpResult(url, null, null, "blocked"),
        errors: [
          {
            code: "FORBIDDEN_IP",
            status: "blocked",
            message: "Private address blocked",
            details: {address: "127.0.0.1"},
          },
        ],
      }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.errors[0].code, "blocked");
  assert.equal(result.errors[0].details.kind, "FORBIDDEN_IP");
  assert.equal(result.output.parsed, null);
});

test("robots adapter rejects credential-bearing targets before HTTP", async () => {
  let called = false;
  const result = await inspectRobots(
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

test("robots adapter never evaluates a partial HTTP response", async () => {
  const result = await inspectRobots(
    "https://example.test/private",
    {},
    {
      now: () => NOW,
      httpAdapter: async ({url}) => ({
        ...httpResult(
          url,
          200,
          "User-agent: *\nAllow: /\n",
          "partial",
        ),
        errors: [
          {
            code: "UNSUPPORTED_CONTENT_ENCODING",
            status: "partial",
            message: "Response bytes could not be decoded reliably",
          },
        ],
      }),
    },
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.output.file_status, "unknown");
  assert.deepEqual(result.output.evaluations, []);
  assert.ok(
    result.errors.some(({details}) => details?.kind === "ROBOTS_HTTP_PARTIAL"),
  );
});

test("robots adapter rejects body limits above the hard cap before HTTP", async () => {
  let called = false;
  const result = await inspectRobots(
    "https://example.test/",
    {maxBodyBytes: 512 * 1024 + 1},
    {
      httpAdapter: async () => {
        called = true;
      },
    },
  );

  assert.equal(result.status, "invalid");
  assert.equal(called, false);
  assert.match(result.errors[0].message, /maxBodyBytes/);
});

test("robots adapter bounds programmatic crawler and path inputs before HTTP", async () => {
  const invalidConfigurations = [
    {crawlers: Array.from({length: 65}, (_, index) => `crawler-${index}`)},
    {crawlers: [`crawler-${"x".repeat(513)}`]},
    {crawlers: [null]},
    {path: `/${"p".repeat(8_192)}`},
  ];

  for (const config of invalidConfigurations) {
    let called = false;
    const result = await inspectRobots(
      "https://example.test/",
      config,
      {
        httpAdapter: async () => {
          called = true;
        },
      },
    );

    assert.equal(result.status, "invalid", JSON.stringify(config).slice(0, 200));
    assert.equal(called, false);
    assert.ok(JSON.stringify(result).length < 20_000);
  }
});

test("robots adapter omits an oversized crawler secret from invalid results", async () => {
  const secret = `crawler-secret-${"s".repeat(600)}`;
  const result = await inspectRobots(
    "https://example.test/",
    {crawlers: [secret]},
    {httpAdapter: async () => assert.fail("HTTP must not be called")},
  );

  assert.equal(result.status, "invalid");
  assert.doesNotMatch(JSON.stringify(result), /crawler-secret/);
});

test("standalone robots results redact sensitive target query values", async () => {
  const result = await inspectRobots(
    "https://example.test/private?token=robots-secret",
    {},
    {
      now: () => NOW,
      httpAdapter: async ({url}) => httpResult(url, 404, ""),
    },
  );

  assert.equal(result.status, "ok");
  assert.doesNotMatch(JSON.stringify(result), /robots-secret/);
  assert.match(
    decodeURIComponent(result.output.evaluations[0].path),
    /token=\[REDACTED\]/,
  );
});
