const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", "\u00a0"],
  ["quot", '"'],
]);
const MAX_SCANNED_TAGS = 10_000;
const MAX_TAG_BYTES = 16 * 1024;
const MAX_TITLE_SOURCE_BYTES = 8 * 1024;
const MAX_HTML_URL_BYTES = 8 * 1024;
const MAX_HTML_PARSE_ERRORS = 100;
const MAX_JSON_LD_BLOCKS = 100;
const MAX_JSON_LD_TYPES = 100;
const MAX_JSON_LD_NODES = 100_000;
const MAX_INTERNAL_LINKS = 500;
const MAX_HREFLANG_LINKS = 100;
const MAX_ROBOT_META_TAGS = 100;
const MAX_PARSED_URL_BYTES = 2 * 1024 * 1024;

function recordHtmlError(errors, message) {
  if (errors.length < MAX_HTML_PARSE_ERRORS && !errors.includes(message)) errors.push(message);
}

function decodeEntities(value) {
  return String(value ?? "").replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal, hexadecimal, named) => {
      if (decimal) {
        const codePoint = Number(decimal);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return NAMED_ENTITIES.get(named.toLowerCase()) ?? entity;
    },
  );
}

function cleanText(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(name in attributes)) attributes[name] = decodeEntities(value).trim();
  }
  return attributes;
}

function relTokens(attributes) {
  return (attributes.rel || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function resolveWebUrl(value, baseUrl, {stripFragment = false} = {}) {
  if (!value) return null;
  try {
    if (Buffer.byteLength(String(value)) > MAX_HTML_URL_BYTES) return null;
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (stripFragment) url.hash = "";
    if (Buffer.byteLength(url.href) > MAX_HTML_URL_BYTES) return null;
    return url.href;
  } catch {
    return null;
  }
}

function findJsonLdTypes(value, types, budget) {
  const stack = [value];
  let truncated = false;
  while (stack.length > 0) {
    if (budget.remaining <= 0) return false;
    budget.remaining -= 1;
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;

    const declared = current["@type"];
    for (const type of Array.isArray(declared) ? declared : [declared]) {
      if (typeof type === "string" && type.trim() && types.size < MAX_JSON_LD_TYPES) {
        types.add(type.trim());
      }
    }

    const children = Array.isArray(current) ? current : Object.values(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (stack.length >= budget.remaining) {
        truncated = true;
        break;
      }
      stack.push(children[index]);
    }
  }
  return !truncated;
}

function scanInterestingTags(html) {
  const tags = [];
  const errors = [];
  const interesting = new Set(["meta", "link", "a", "base", "title"]);
  let tagStart = -1;
  let quote = null;
  let scanned = 0;
  let malformedTagReported = false;

  for (let index = 0; index < html.length; index += 1) {
    const character = html[index];
    if (tagStart === -1) {
      if (character === "<") tagStart = index;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "<") {
      if (!malformedTagReported) {
        recordHtmlError(errors, "An HTML tag was not closed");
        malformedTagReported = true;
      }
      tagStart = index;
      continue;
    }
    if (character !== ">") continue;

    const raw = html.slice(tagStart + 1, index);
    tagStart = -1;
    const trimmed = raw.trimStart();
    const closing = trimmed.startsWith("/");
    const nameSource = closing ? trimmed.slice(1).trimStart() : trimmed;
    const name = /^[A-Za-z][\w:-]*/u.exec(nameSource)?.[0]?.toLowerCase() ?? null;
    if (!name) continue;
    scanned += 1;
    if (scanned > MAX_SCANNED_TAGS) {
      recordHtmlError(errors, `HTML tag scan stopped at the ${MAX_SCANNED_TAGS}-tag safety limit`);
      break;
    }
    if (!interesting.has(name)) continue;
    if (Buffer.byteLength(raw) > MAX_TAG_BYTES) {
      recordHtmlError(errors, `An HTML ${name} tag exceeded the ${MAX_TAG_BYTES}-byte safety limit`);
      continue;
    }
    const nameOffset = nameSource.toLowerCase().indexOf(name) + name.length;
    tags.push({
      name,
      closing,
      start: index - raw.length - 1,
      end: index,
      attributes: closing ? Object.create(null) : parseAttributes(nameSource.slice(nameOffset)),
    });
  }
  if (tagStart !== -1) recordHtmlError(errors, "An HTML tag was not closed");
  return {tags, errors};
}

function findHtmlTag(source, lowerSource, name, from, closing) {
  let cursor = from;
  while (cursor < source.length) {
    const start = lowerSource.indexOf("<", cursor);
    if (start === -1) return null;
    let nameStart = start + 1;
    while (/\s/u.test(lowerSource[nameStart] ?? "")) nameStart += 1;
    const isClosing = lowerSource[nameStart] === "/";
    if (isClosing) {
      nameStart += 1;
      while (/\s/u.test(lowerSource[nameStart] ?? "")) nameStart += 1;
    }
    const nameEnd = nameStart + name.length;
    const boundary = lowerSource[nameEnd] ?? "";
    if (
      isClosing === closing &&
      lowerSource.slice(nameStart, nameEnd) === name &&
      (!boundary || /[\s/>]/u.test(boundary))
    ) {
      const end = lowerSource.indexOf(">", nameEnd);
      if (end === -1) return null;
      return {start, end, attributes: source.slice(nameEnd, end)};
    }
    cursor = start + 1;
  }
  return null;
}

function parseJsonLd(html) {
  const lowerHtml = html.toLowerCase();
  let openingCount = 0;
  const types = new Set();
  const errors = [];
  let parsedCount = 0;
  let cursor = 0;
  let traversalTruncated = false;
  const nodeBudget = {remaining: MAX_JSON_LD_NODES};

  while (cursor < html.length) {
    const opening = findHtmlTag(html, lowerHtml, "script", cursor, false);
    if (!opening) break;
    const attributes = parseAttributes(opening.attributes);
    const type = (attributes.type || "").toLowerCase().split(";")[0].trim();
    const isJsonLd = type === "application/ld+json";
    if (isJsonLd) {
      openingCount += 1;
      if (openingCount > MAX_JSON_LD_BLOCKS) {
        recordHtmlError(
          errors,
          `JSON-LD parsing stopped at the ${MAX_JSON_LD_BLOCKS}-block safety limit`,
        );
        break;
      }
    }

    const closing = findHtmlTag(html, lowerHtml, "script", opening.end + 1, true);
    if (!closing) {
      if (isJsonLd) recordHtmlError(errors, "A JSON-LD block was not closed");
      break;
    }
    if (isJsonLd) {
      try {
        const value = JSON.parse(html.slice(opening.end + 1, closing.start).trim());
        parsedCount += 1;
        if (!findJsonLdTypes(value, types, nodeBudget)) {
          traversalTruncated = true;
          recordHtmlError(
            errors,
            `JSON-LD traversal stopped at the ${MAX_JSON_LD_NODES}-node safety limit`,
          );
          break;
        }
      } catch {
        recordHtmlError(errors, "A JSON-LD block could not be parsed");
      }
    }
    cursor = closing.end + 1;
  }

  return {
    present: openingCount > 0,
    count: openingCount,
    parsed_count: parsedCount,
    types: [...types],
    parse_errors: errors,
    truncated: openingCount > MAX_JSON_LD_BLOCKS || traversalTruncated,
  };
}

export function parseHtmlMetadata(html, pageUrl) {
  const source = String(html ?? "");
  let documentUrl;
  try {
    documentUrl = new URL(pageUrl);
    if (
      (documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
      documentUrl.username ||
      documentUrl.password
    ) {
      throw new TypeError();
    }
  } catch {
    throw new TypeError("pageUrl must be an absolute credential-free http or https URL");
  }

  const scanned = scanInterestingTags(source);
  const tags = scanned.tags.filter(({closing}) => !closing);
  const baseTag = tags.find(({name, attributes}) => name === "base" && attributes.href);
  const baseHref = resolveWebUrl(baseTag?.attributes.href, documentUrl) || documentUrl.href;

  let title = null;
  const titleOpening = scanned.tags.find(({name, closing}) => name === "title" && !closing);
  if (titleOpening) {
    const titleClosing = scanned.tags.find(
      ({name, closing, start}) => name === "title" && closing && start > titleOpening.end,
    );
    const nextTag = source.indexOf("<", titleOpening.end + 1);
    const titleEnd = titleClosing?.start ?? (nextTag === -1 ? source.length : nextTag);
    const boundedTitleEnd = Math.min(titleEnd, titleOpening.end + 1 + MAX_TITLE_SOURCE_BYTES);
    title = cleanText(source.slice(titleOpening.end + 1, boundedTitleEnd)) || null;
    if (boundedTitleEnd < titleEnd) {
      recordHtmlError(scanned.errors, "Title text exceeded the safety limit");
    }
  }

  let description = null;
  let metaRobots = null;
  const robotMetaTags = [];
  let canonical = null;
  const hreflang = [];
  const internalLinks = [];
  const internalSeen = new Set();
  let parsedUrlBytes = 0;
  let parsedUrlsTruncated = false;

  for (const {name, attributes} of tags) {
    if (name === "meta") {
      const metaName = (attributes.name || "").toLowerCase();
      if (metaName === "description" && description === null) {
        description = attributes.content || null;
      }
      if (metaName === "robots" || metaName.endsWith("bot")) {
        const content = attributes.content || "";
        const directives = content
          .toLowerCase()
          .split(/[,;]/)
          .map((directive) => directive.trim())
          .filter(Boolean);
        if (robotMetaTags.length < MAX_ROBOT_META_TAGS) {
          robotMetaTags.push({name: metaName, content, directives});
        } else {
          recordHtmlError(scanned.errors, "Robots meta tag collection reached its safety limit");
        }
        if (metaName === "robots" && metaRobots === null) metaRobots = content || null;
      }
      continue;
    }

    if (name === "link") {
      const rel = relTokens(attributes);
      if (canonical === null && rel.includes("canonical")) {
        canonical = resolveWebUrl(attributes.href, baseHref);
      }
      if (rel.includes("alternate") && attributes.hreflang) {
        const href = resolveWebUrl(attributes.href, baseHref);
        const hrefBytes = href ? Buffer.byteLength(href) : 0;
        if (
          href &&
          hreflang.length < MAX_HREFLANG_LINKS &&
          parsedUrlBytes + hrefBytes <= MAX_PARSED_URL_BYTES
        ) {
          hreflang.push({lang: attributes.hreflang, href});
          parsedUrlBytes += hrefBytes;
        } else if (href) {
          parsedUrlsTruncated = true;
        }
      }
      continue;
    }

    if (name === "a") {
      const href = resolveWebUrl(attributes.href, baseHref, {stripFragment: true});
      if (!href) continue;
      const target = new URL(href);
      if (target.origin === documentUrl.origin && !internalSeen.has(href)) {
        const hrefBytes = Buffer.byteLength(href);
        if (
          internalLinks.length >= MAX_INTERNAL_LINKS ||
          parsedUrlBytes + hrefBytes > MAX_PARSED_URL_BYTES
        ) {
          parsedUrlsTruncated = true;
          continue;
        }
        internalSeen.add(href);
        internalLinks.push(href);
        parsedUrlBytes += hrefBytes;
      }
    }
  }

  const structuredData = parseJsonLd(source);
  if (parsedUrlsTruncated) {
    recordHtmlError(scanned.errors, "Parsed URL collection reached its safety limit");
  }
  const noindex = robotMetaTags.some(({directives}) => directives.includes("noindex"));

  return {
    title,
    description,
    canonical,
    meta_robots: metaRobots,
    robot_meta_tags: robotMetaTags,
    noindex,
    hreflang,
    structured_data: structuredData,
    internal_links: internalLinks,
    parsed_url_bytes: parsedUrlBytes,
    parsed_urls_truncated: parsedUrlsTruncated,
    base_url: baseHref,
    parse_errors: [...new Set([...scanned.errors, ...structuredData.parse_errors])],
  };
}
