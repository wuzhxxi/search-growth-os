import {readFileSync} from "node:fs";

const DEFAULT_MAX_ROBOTS_BYTES = 512 * 1024;
const DEFAULT_MAX_ROBOTS_DIRECTIVES = 10_000;
const MAX_ROBOTS_RULE_PATTERN_BYTES = 2_048;
const MAX_ROBOTS_TARGET_BYTES = 8_192;
const MAX_ROBOTS_MATCH_STEPS = 1_000_000;
const registryUrl = new URL("./crawler-registry.json", import.meta.url);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CRAWLER_REGISTRY = deepFreeze(
  JSON.parse(readFileSync(registryUrl, "utf8")),
);

export const SUPPORTED_CRAWLERS = Object.freeze(
  CRAWLER_REGISTRY.crawlers.map(({crawler}) => crawler),
);

export function loadCrawlerRegistry() {
  return structuredClone(CRAWLER_REGISTRY);
}

function parseError(code, message, line = null) {
  return line === null ? {code, message} : {code, message, line};
}

function emptyParseResult(status, byteLength, errors) {
  return {
    status,
    byte_length: byteLength,
    groups: [],
    sitemaps: [],
    parse_errors: errors,
  };
}

/**
 * Parse the directives needed for a technical audit without treating unknown
 * extensions as failures. The source remains separate from this parsed view.
 */
export function parseRobotsTxt(
  source,
  {
    maxBytes = DEFAULT_MAX_ROBOTS_BYTES,
    maxDirectives = DEFAULT_MAX_ROBOTS_DIRECTIVES,
  } = {},
) {
  if (typeof source !== "string") {
    return emptyParseResult("invalid", 0, [
      parseError("ROBOTS_SOURCE_INVALID", "robots.txt source must be a string"),
    ]);
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_ROBOTS_BYTES) {
    return emptyParseResult("invalid", Buffer.byteLength(source), [
      parseError(
        "ROBOTS_LIMIT_INVALID",
        `maxBytes must be an integer between 1 and ${DEFAULT_MAX_ROBOTS_BYTES}`,
      ),
    ]);
  }
  if (
    !Number.isSafeInteger(maxDirectives) ||
    maxDirectives < 1 ||
    maxDirectives > DEFAULT_MAX_ROBOTS_DIRECTIVES
  ) {
    return emptyParseResult("invalid", Buffer.byteLength(source), [
      parseError(
        "ROBOTS_LIMIT_INVALID",
        `maxDirectives must be an integer between 1 and ${DEFAULT_MAX_ROBOTS_DIRECTIVES}`,
      ),
    ]);
  }

  const byteLength = Buffer.byteLength(source);
  if (byteLength > maxBytes) {
    return emptyParseResult("invalid", byteLength, [
      parseError(
        "ROBOTS_BODY_TOO_LARGE",
        `robots.txt is ${byteLength} bytes; configured maximum is ${maxBytes}`,
      ),
    ]);
  }

  const groups = [];
  const sitemaps = [];
  const parseErrors = [];
  let currentGroup = null;
  let currentGroupHasRules = false;
  let directiveCount = 0;
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n?|\n/);

  const startGroup = (line) => {
    const group = {
      user_agents: [],
      allow: [],
      disallow: [],
      rules: [],
      line,
    };
    groups.push(group);
    currentGroup = group;
    currentGroupHasRules = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const withoutComment = lines[index].split("#", 1)[0].trim();
    if (!withoutComment) continue;
    directiveCount += 1;
    if (directiveCount > maxDirectives) {
      return emptyParseResult("invalid", byteLength, [
        ...parseErrors,
        parseError(
          "ROBOTS_DIRECTIVE_LIMIT",
          `robots.txt directives exceed the configured maximum of ${maxDirectives}`,
          lineNumber,
        ),
      ]);
    }

    const colon = withoutComment.indexOf(":");
    if (colon < 0) {
      parseErrors.push(
        parseError("ROBOTS_DIRECTIVE_MALFORMED", "Directive has no colon", lineNumber),
      );
      continue;
    }

    const directive = withoutComment.slice(0, colon).trim().toLowerCase();
    const value = withoutComment.slice(colon + 1).trim();

    if (directive === "sitemap") {
      if (value && Buffer.byteLength(value) <= MAX_ROBOTS_TARGET_BYTES) sitemaps.push(value);
      else if (value) {
        parseErrors.push(
          parseError(
            "ROBOTS_SITEMAP_TOO_LONG",
            `Sitemap value exceeds ${MAX_ROBOTS_TARGET_BYTES} bytes`,
            lineNumber,
          ),
        );
      }
      else {
        parseErrors.push(
          parseError("ROBOTS_SITEMAP_EMPTY", "Sitemap directive has no value", lineNumber),
        );
      }
      continue;
    }

    if (directive === "user-agent") {
      if (!value) {
        parseErrors.push(
          parseError("ROBOTS_USER_AGENT_EMPTY", "User-agent directive has no value", lineNumber),
        );
        continue;
      }
      if (Buffer.byteLength(value) > 512) {
        return emptyParseResult("invalid", byteLength, [
          ...parseErrors,
          parseError(
            "ROBOTS_USER_AGENT_TOO_LONG",
            "User-agent value exceeds 512 bytes",
            lineNumber,
          ),
        ]);
      }
      if (!currentGroup || currentGroupHasRules) startGroup(lineNumber);
      currentGroup.user_agents.push(value);
      continue;
    }

    if (directive !== "allow" && directive !== "disallow") continue;
    if (!currentGroup || currentGroup.user_agents.length === 0) {
      parseErrors.push(
        parseError(
          "ROBOTS_RULE_WITHOUT_AGENT",
          `${directive} directive appears before a User-agent group`,
          lineNumber,
        ),
      );
      continue;
    }
    if (Buffer.byteLength(value) > MAX_ROBOTS_RULE_PATTERN_BYTES) {
      return emptyParseResult("invalid", byteLength, [
        ...parseErrors,
        parseError(
          "ROBOTS_PATTERN_TOO_LONG",
          `Robots rule pattern exceeds ${MAX_ROBOTS_RULE_PATTERN_BYTES} bytes`,
          lineNumber,
        ),
      ]);
    }

    currentGroupHasRules = true;
    const rule = {directive, path: value, line: lineNumber};
    currentGroup.rules.push(rule);
    currentGroup[directive].push(value);
  }

  return {
    status: parseErrors.length ? "partial" : "ok",
    byte_length: byteLength,
    groups,
    sitemaps: [...new Set(sitemaps)],
    parse_errors: parseErrors,
  };
}

function crawlerMetadata(userAgent, registry) {
  const requested = String(userAgent ?? "").trim();
  const metadata = registry.crawlers.find(
    ({crawler}) => crawler.toLowerCase() === requested.toLowerCase(),
  );
  return {
    requested,
    metadata: metadata ?? null,
    token: (metadata?.robots_token ?? requested).toLowerCase(),
  };
}

function groupMatchScore(group, token) {
  let best = -1;
  for (const value of group.user_agents ?? []) {
    const candidate = String(value).trim().toLowerCase();
    if (candidate === "*") best = Math.max(best, 0);
    // REP group selection matches the product token itself. The product token
    // may be a substring of an HTTP User-Agent header, but not of another
    // robots.txt product token (for example, "bot" must not match "Googlebot").
    else if (candidate && candidate === token) best = Math.max(best, candidate.length);
  }
  return best;
}

const ASCII_UNRESERVED = /^[A-Za-z0-9._~-]$/u;
const ASCII_RESERVED = new Set(":/?#[]@!$&'()*+,;=".split(""));

function percentEncodeCharacter(character) {
  return [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

// RFC 9309 compares URI octets. Percent-encoded ASCII unreserved characters
// are decoded before comparison; reserved and non-ASCII octets stay encoded.
function normalizeRobotsOctets(value) {
  const source = String(value ?? "");
  let normalized = "";
  for (let index = 0; index < source.length;) {
    const character = String.fromCodePoint(source.codePointAt(index));
    if (
      character === "%" &&
      index + 2 < source.length &&
      /^[\da-f]{2}$/iu.test(source.slice(index + 1, index + 3))
    ) {
      const byte = Number.parseInt(source.slice(index + 1, index + 3), 16);
      const decoded = String.fromCharCode(byte);
      normalized += ASCII_UNRESERVED.test(decoded)
        ? decoded
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      index += 3;
      continue;
    }

    const codePoint = character.codePointAt(0);
    if (
      codePoint >= 0x21 &&
      codePoint <= 0x7e &&
      (ASCII_UNRESERVED.test(character) || ASCII_RESERVED.has(character)) &&
      character !== "%"
    ) {
      normalized += character;
    } else {
      normalized += percentEncodeCharacter(character);
    }
    index += character.length;
  }
  return normalized;
}

// Linear wildcard matcher. Unanchored robots patterns implicitly match any
// suffix. A shared operation budget prevents pathological aggregate work.
function pathPatternMatches(pattern, path, budget) {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const glob = anchored ? core : `${core}*`;
  let pathIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starPathIndex = 0;

  while (pathIndex < path.length) {
    budget.remaining -= 1;
    if (budget.remaining < 0) return null;
    if (patternIndex < glob.length && glob[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      starPathIndex = pathIndex;
      continue;
    }
    if (patternIndex < glob.length && glob[patternIndex] === path[pathIndex]) {
      patternIndex += 1;
      pathIndex += 1;
      continue;
    }
    if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starPathIndex += 1;
      pathIndex = starPathIndex;
      continue;
    }
    return false;
  }
  while (patternIndex < glob.length && glob[patternIndex] === "*") patternIndex += 1;
  return patternIndex === glob.length;
}

function ruleSpecificity(pattern) {
  const withoutEndAnchor = pattern.endsWith("$") ? pattern.slice(0, -1) : pattern;
  return Buffer.byteLength(withoutEndAnchor.replaceAll("*", ""));
}

function targetPath(target) {
  const value = String(target ?? "/");
  try {
    const url = new URL(value);
    return normalizeRobotsOctets(`${url.pathname}${url.search}` || "/");
  } catch {
    const withoutFragment = value.split("#", 1)[0] || "/";
    return normalizeRobotsOctets(
      withoutFragment.startsWith("/") ? withoutFragment : `/${withoutFragment}`,
    );
  }
}

/**
 * Evaluate the robots.txt rule that applies to a crawler and URL path.
 * A true result is a crawl-rule result only; it is never an indexing or
 * citation guarantee.
 */
export function evaluateRobotsPolicy(
  parsed,
  userAgent,
  target = "/",
  {registry = CRAWLER_REGISTRY} = {},
) {
  const path = targetPath(target);
  const {requested, metadata, token} = crawlerMetadata(userAgent, registry);
  const caution =
    "A robots.txt Allow result does not guarantee crawling, indexing, ranking, answer inclusion, or citation.";

  if (!requested) {
    return {
      status: "invalid",
      crawler: requested,
      robots_token: null,
      path,
      allowed: null,
      matched_group_indexes: [],
      matched_rule: null,
      reason: "crawler_required",
      caution,
    };
  }
  if (Buffer.byteLength(path) > MAX_ROBOTS_TARGET_BYTES) {
    return {
      status: "invalid",
      crawler: requested,
      robots_token: metadata?.robots_token ?? requested,
      path: null,
      allowed: null,
      matched_group_indexes: [],
      matched_rule: null,
      reason: "robots_target_too_long",
      caution,
    };
  }
  if (!parsed || !Array.isArray(parsed.groups) || parsed.status === "invalid") {
    return {
      status: "invalid",
      crawler: requested,
      robots_token: metadata?.robots_token ?? requested,
      path,
      allowed: null,
      matched_group_indexes: [],
      matched_rule: null,
      reason: "robots_rules_unavailable",
      caution,
    };
  }

  const scores = parsed.groups.map((group) => groupMatchScore(group, token));
  const specificScore = Math.max(-1, ...scores.filter((score) => score > 0));
  const selectedScore = specificScore > 0 ? specificScore : scores.includes(0) ? 0 : -1;
  const groupIndexes = scores
    .map((score, index) => ({score, index}))
    .filter(({score}) => score === selectedScore && selectedScore >= 0)
    .map(({index}) => index);

  let winningRule = null;
  const budget = {remaining: MAX_ROBOTS_MATCH_STEPS};
  for (const groupIndex of groupIndexes) {
    const group = parsed.groups[groupIndex];
    for (const rule of group.rules ?? []) {
      if (!rule.path) continue;
      if (Buffer.byteLength(rule.path) > MAX_ROBOTS_RULE_PATTERN_BYTES) {
        return {
          status: "invalid",
          crawler: requested,
          robots_token: metadata?.robots_token ?? requested,
          path,
          allowed: null,
          matched_group_indexes: groupIndexes,
          matched_rule: null,
          reason: "robots_pattern_too_long",
          caution,
        };
      }
      const normalizedPattern = normalizeRobotsOctets(rule.path);
      const matches = pathPatternMatches(normalizedPattern, path, budget);
      if (matches === null) {
        return {
          status: "invalid",
          crawler: requested,
          robots_token: metadata?.robots_token ?? requested,
          path,
          allowed: null,
          matched_group_indexes: groupIndexes,
          matched_rule: null,
          reason: "robots_evaluation_limit",
          caution,
        };
      }
      if (!matches) continue;
      const specificity = ruleSpecificity(normalizedPattern);
      if (
        !winningRule ||
        specificity > winningRule.specificity ||
        (specificity === winningRule.specificity &&
          rule.directive === "allow" &&
          winningRule.directive !== "allow")
      ) {
        winningRule = {...rule, group_index: groupIndex, specificity};
      }
    }
  }

  const allowed = winningRule ? winningRule.directive === "allow" : true;
  return {
    status: "evaluated",
    crawler: requested,
    robots_token: metadata?.robots_token ?? requested,
    purpose: metadata?.purpose ?? null,
    source: metadata?.source ?? null,
    registry_status: metadata?.status ?? "unregistered",
    robots_policy_applicability:
      metadata?.robots_policy_applicability ?? "unknown",
    path,
    allowed,
    matched_group_indexes: groupIndexes,
    matched_rule: winningRule,
    reason: winningRule
      ? `matched_${winningRule.directive}`
      : groupIndexes.length
        ? "no_matching_rule"
        : "no_applicable_group",
    caution,
  };
}

export function isPathAllowed(parsed, userAgent, target = "/", options = {}) {
  return evaluateRobotsPolicy(parsed, userAgent, target, options).allowed;
}

export {
  DEFAULT_MAX_ROBOTS_BYTES,
  DEFAULT_MAX_ROBOTS_DIRECTIVES,
  MAX_ROBOTS_MATCH_STEPS,
  MAX_ROBOTS_RULE_PATTERN_BYTES,
  MAX_ROBOTS_TARGET_BYTES,
};
