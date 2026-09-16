import {lookup as systemLookup} from "node:dns/promises";
import {isIP} from "node:net";

const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const MAX_URL_BYTES = 8_192;

const FORBIDDEN_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google",
  "metadata.goog",
  "metadata.aws.internal",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".home.arpa"];

const FORBIDDEN_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export class UrlPolicyError extends Error {
  constructor(code, message, {status = "blocked", url, hostname, cause} = {}) {
    super(message, {cause});
    this.name = "UrlPolicyError";
    this.code = code;
    this.status = status;
    if (url !== undefined) this.url = url;
    if (hostname !== undefined) this.hostname = hostname;
  }
}

function normalizeHostname(hostname) {
  const unbracketed = String(hostname).replace(/^\[|\]$/g, "");
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function ipv4ToNumber(address) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function ipv4InRange(address, network, prefix) {
  const value = ipv4ToNumber(address);
  const base = ipv4ToNumber(network);
  if (value === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function expandEmbeddedIpv4(address) {
  if (!address.includes(".")) return address;
  const lastColon = address.lastIndexOf(":");
  const numeric = ipv4ToNumber(address.slice(lastColon + 1));
  if (numeric === null) return null;
  const high = ((numeric >>> 16) & 0xffff).toString(16);
  const low = (numeric & 0xffff).toString(16);
  return `${address.slice(0, lastColon)}:${high}:${low}`;
}

function ipv6ToBigInt(address) {
  const expandedAddress = expandEmbeddedIpv4(address.toLowerCase().split("%")[0]);
  if (!expandedAddress) return null;
  const halves = expandedAddress.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InRange(value, network, prefix) {
  const base = ipv6ToBigInt(network);
  if (value === null || base === null) return false;
  const shift = 128n - BigInt(prefix);
  return value >> shift === base >> shift;
}

function embeddedIpv4(value, shift = 0n) {
  const mask = 0xffffffffn;
  const numeric = Number((value >> shift) & mask);
  return [numeric >>> 24, (numeric >>> 16) & 255, (numeric >>> 8) & 255, numeric & 255].join(
    ".",
  );
}

function isForbiddenIpv4(address) {
  return FORBIDDEN_IPV4_RANGES.some(([network, prefix]) =>
    ipv4InRange(address, network, prefix),
  );
}

function isForbiddenIpv6(address) {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;

  // IPv4-compatible and IPv4-mapped addresses must inherit the IPv4 policy.
  if (value >> 32n === 0n || value >> 32n === 0xffffn) {
    return isForbiddenIpv4(embeddedIpv4(value));
  }

  // Only the currently allocated global-unicast space is accepted by default.
  if (!ipv6InRange(value, "2000::", 3)) return true;

  // Globally non-routable/documentation ranges inside 2000::/3.
  if (
    ipv6InRange(value, "2001::", 32) ||
    ipv6InRange(value, "2001:2::", 48) ||
    ipv6InRange(value, "2001:10::", 28) ||
    ipv6InRange(value, "2001:20::", 28) ||
    ipv6InRange(value, "2001:db8::", 32) ||
    ipv6InRange(value, "3fff::", 20)
  ) {
    return true;
  }

  // 6to4 embeds an IPv4 destination. Do not let it smuggle a private address.
  if (ipv6InRange(value, "2002::", 16)) {
    return isForbiddenIpv4(embeddedIpv4(value, 80n));
  }

  return false;
}

export function isForbiddenIp(address) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isForbiddenIpv4(normalized);
  if (family === 6) return isForbiddenIpv6(normalized);
  return true;
}

export function isForbiddenHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return (
    FORBIDDEN_HOSTS.has(normalized) ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function validateHttpUrl(value) {
  let url;
  const source = value instanceof URL ? value.href : String(value);
  if (Buffer.byteLength(source) > MAX_URL_BYTES) {
    throw new UrlPolicyError("URL_TOO_LONG", `URL exceeds the ${MAX_URL_BYTES}-byte limit`, {
      status: "invalid",
    });
  }
  try {
    url = new URL(source);
  } catch (cause) {
    throw new UrlPolicyError("INVALID_URL", "A valid absolute URL is required", {
      status: "invalid",
      cause,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError("UNSUPPORTED_PROTOCOL", "Only http: and https: URLs are allowed", {
      status: "invalid",
      url: url.href,
    });
  }
  if (url.username || url.password) {
    throw new UrlPolicyError("URL_CREDENTIALS_BLOCKED", "Credentials in URLs are not allowed", {
      status: "blocked",
      url: url.href,
    });
  }
  if (Buffer.byteLength(url.href) > MAX_URL_BYTES) {
    throw new UrlPolicyError("URL_TOO_LONG", `Normalized URL exceeds the ${MAX_URL_BYTES}-byte limit`, {
      status: "invalid",
    });
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new UrlPolicyError("MISSING_HOSTNAME", "URL hostname is required", {
      status: "invalid",
      url: url.href,
    });
  }
  if (isForbiddenHostname(hostname)) {
    throw new UrlPolicyError("FORBIDDEN_HOSTNAME", "Local and metadata hostnames are blocked", {
      url: url.href,
      hostname,
    });
  }
  if (isIP(hostname) && isForbiddenIp(hostname)) {
    throw new UrlPolicyError("FORBIDDEN_IP", "Non-public IP addresses are blocked", {
      url: url.href,
      hostname,
    });
  }

  return url;
}

function normalizeLookupResults(results) {
  const values = Array.isArray(results) ? results : [results];
  const normalized = [];
  for (const result of values) {
    const address = typeof result === "string" ? result : result?.address;
    const family = typeof result === "object" && result ? Number(result.family) : isIP(address);
    if (!address || (family !== 4 && family !== 6) || isIP(address) !== family) {
      throw new UrlPolicyError("INVALID_DNS_RESPONSE", "DNS returned an invalid address", {
        status: "unavailable",
      });
    }
    normalized.push({address: normalizeHostname(address), family});
  }
  return normalized.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) => candidate.address === item.address && candidate.family === item.family,
      ) === index,
  );
}

async function lookupWithTimeout(lookup, hostname, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(() => lookup(hostname, {all: true, verbatim: true})),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new UrlPolicyError("DNS_TIMEOUT", "DNS resolution timed out", {
                status: "timeout",
                hostname,
              }),
            ),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createPinnedLookup(addresses, expectedHostname) {
  const pinned = normalizeLookupResults(addresses);
  if (pinned.length === 0 || pinned.some(({address}) => isForbiddenIp(address))) {
    throw new UrlPolicyError("FORBIDDEN_DNS_ADDRESS", "DNS pin set must contain only public IPs");
  }
  const expected = expectedHostname ? normalizeHostname(expectedHostname) : null;

  return function pinnedLookup(hostname, options, callback) {
    let lookupOptions = options;
    let done = callback;
    if (typeof options === "function") {
      done = options;
      lookupOptions = {};
    } else if (typeof options === "number") {
      lookupOptions = {family: options};
    }

    if (typeof done !== "function") throw new TypeError("lookup callback is required");
    if (expected && normalizeHostname(hostname) !== expected) {
      const error = new Error("Pinned DNS lookup was requested for an unexpected hostname");
      error.code = "EACCES";
      queueMicrotask(() => done(error));
      return;
    }

    const requestedFamily = Number(lookupOptions?.family || 0);
    const eligible = requestedFamily
      ? pinned.filter(({family}) => family === requestedFamily)
      : pinned;
    if (eligible.length === 0) {
      const error = new Error("No pinned address matches the requested family");
      error.code = "EAI_ADDRFAMILY";
      queueMicrotask(() => done(error));
      return;
    }

    queueMicrotask(() => {
      if (lookupOptions?.all) done(null, eligible.map((item) => ({...item})));
      else done(null, eligible[0].address, eligible[0].family);
    });
  };
}

export async function resolveAndPinUrl(
  value,
  {lookup = systemLookup, dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS} = {},
) {
  const url = validateHttpUrl(value);
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses;

  if (literalFamily) {
    addresses = [{address: hostname, family: literalFamily}];
  } else {
    let results;
    try {
      results = await lookupWithTimeout(lookup, hostname, dnsTimeoutMs);
    } catch (error) {
      if (error instanceof UrlPolicyError) throw error;
      throw new UrlPolicyError("DNS_RESOLUTION_FAILED", "DNS resolution failed", {
        status: "unavailable",
        url: url.href,
        hostname,
        cause: error,
      });
    }
    addresses = normalizeLookupResults(results);
    if (addresses.length === 0) {
      throw new UrlPolicyError("DNS_NO_ADDRESSES", "DNS returned no addresses", {
        status: "unavailable",
        url: url.href,
        hostname,
      });
    }
    const forbidden = addresses.find(({address}) => isForbiddenIp(address));
    if (forbidden) {
      throw new UrlPolicyError(
        "FORBIDDEN_DNS_ADDRESS",
        "DNS resolved to a non-public address; the request was blocked",
        {url: url.href, hostname, address: forbidden.address},
      );
    }
  }

  return {
    url,
    hostname,
    addresses,
    lookup: createPinnedLookup(addresses, hostname),
  };
}

export const validatePublicHttpUrl = resolveAndPinUrl;
export {MAX_URL_BYTES};
