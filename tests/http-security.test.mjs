import test from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTER_STATUSES,
  adapterError,
  createAdapterResult,
} from "../lib/core/adapter-result.mjs";
import {
  UrlPolicyError,
  createPinnedLookup,
  isForbiddenIp,
  resolveAndPinUrl,
  validateHttpUrl,
} from "../lib/security/url-policy.mjs";

test("adapter results use the common structured contract", () => {
  assert.deepEqual(ADAPTER_STATUSES, [
    "ok",
    "partial",
    "UNKNOWN",
    "unavailable",
    "timeout",
    "blocked",
    "invalid",
  ]);
  const result = createAdapterResult({
    adapter: {id: "fixture", name: "Fixture", version: "1.0.0", capabilities: ["read"]},
    status: "UNKNOWN",
    input: {target: "fixture"},
    output: null,
    observedAt: "2026-01-01T00:00:00.000Z",
    errors: [adapterError("NO_DATA", "No fixture data")],
  });
  assert.deepEqual(Object.keys(result), [
    "id",
    "name",
    "version",
    "capabilities",
    "input",
    "output",
    "evidence",
    "observed_at",
    "errors",
    "status",
  ]);
  assert.equal(result.status, "UNKNOWN");
  assert.throws(
    () => createAdapterResult({adapter: {id: "x", name: "X", version: "1"}, status: "guess"}),
    /unsupported adapter status/,
  );
});
test("URL syntax policy allows only credential-free HTTP(S)", () => {
  assert.equal(validateHttpUrl("https://example.com/a").href, "https://example.com/a");
  for (const value of [
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://user:secret@example.com/",
  ]) {
    assert.throws(() => validateHttpUrl(value), UrlPolicyError);
  }
});

test("URL policy blocks localhost, metadata, and non-public literal addresses", () => {
  for (const value of [
    "http://localhost/",
    "http://service.local/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/latest/meta-data/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2002:7f00:1::]/",
  ]) {
    assert.throws(
      () => validateHttpUrl(value),
      (error) => error instanceof UrlPolicyError && error.status === "blocked",
      value,
    );
  }
  assert.equal(isForbiddenIp("8.8.8.8"), false);
  assert.equal(isForbiddenIp("2001:4860:4860::8888"), false);
});

test("DNS resolution rejects any private result and returns a pinned public lookup", async () => {
  let privateLookups = 0;
  await assert.rejects(
    resolveAndPinUrl("https://mixed.example/", {
      lookup: async () => {
        privateLookups += 1;
        return [
          {address: "93.184.216.34", family: 4},
          {address: "10.0.0.9", family: 4},
        ];
      },
    }),
    (error) => error instanceof UrlPolicyError && error.code === "FORBIDDEN_DNS_ADDRESS",
  );
  assert.equal(privateLookups, 1);

  const pinned = await resolveAndPinUrl("https://public.example/", {
    lookup: async () => [{address: "93.184.216.34", family: 4}],
  });
  assert.deepEqual(pinned.addresses, [{address: "93.184.216.34", family: 4}]);
  const lookedUp = await new Promise((resolve, reject) => {
    pinned.lookup("public.example", {all: true}, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });
  assert.deepEqual(lookedUp, [{address: "93.184.216.34", family: 4}]);
});

test("pinned DNS lookup cannot be reused for another hostname", async () => {
  const lookup = createPinnedLookup([{address: "93.184.216.34", family: 4}], "one.example");
  await assert.rejects(
    new Promise((resolve, reject) =>
      lookup("two.example", {}, (error, address) => (error ? reject(error) : resolve(address))),
    ),
    (error) => error.code === "EACCES",
  );
});
