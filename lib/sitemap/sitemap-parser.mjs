const DEFAULT_MAX_SITEMAP_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SITEMAP_ENTRIES = 50_000;
const DEFAULT_SAMPLE_URLS = 20;
const MAX_SITEMAP_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SITEMAP_ENTRIES = 100_000;
const MAX_SAMPLE_URLS = 100;
const MAX_SITEMAP_URL_BYTES = 8_192;
const MAX_PARSE_ERRORS = 100;

function parseError(code, message, entry = null) {
  return entry === null ? {code, message} : {code, message, entry};
}

function emptyResult(status, byteLength, errors) {
  return {
    status,
    type: "unknown",
    byte_length: byteLength,
    url_count: 0,
    child_sitemap_count: 0,
    urls: [],
    child_sitemaps: [],
    sample_urls: [],
    parse_errors: errors,
    parse_error_count: errors.length,
    parse_errors_truncated: false,
    truncated: false,
  };
}

function decodeEntity(entity) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  if (Object.hasOwn(named, entity)) return named[entity];
  const numeric = entity.startsWith("#x") || entity.startsWith("#X")
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith("#")
      ? Number.parseInt(entity.slice(1), 10)
      : Number.NaN;
  if (
    Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric <= 0x10ffff &&
    !(numeric >= 0xd800 && numeric <= 0xdfff)
  ) {
    return String.fromCodePoint(numeric);
  }
  return null;
}

function decodeLoc(raw, parseErrors, entry) {
  let value = raw.trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1].trim();

  let invalidEntity = false;
  const encodedEntity = /&([^;\s]+);/g;
  const withoutEncodedEntities = value.replace(encodedEntity, "");
  if (withoutEncodedEntities.includes("&")) invalidEntity = true;
  value = value.replace(encodedEntity, (match, entity) => {
    const decoded = decodeEntity(entity);
    if (decoded === null) {
      invalidEntity = true;
      return match;
    }
    return decoded;
  });
  if (invalidEntity) {
    parseErrors.push(
      parseError("SITEMAP_ENTITY_INVALID", "loc contains an invalid XML entity", entry),
    );
    return null;
  }
  return value.trim();
}

function findElementTag(source, lowerSource, localName, from, closing) {
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
    let nameEnd = nameStart;
    while (nameEnd < lowerSource.length && !/[\s/<>]/u.test(lowerSource[nameEnd])) {
      nameEnd += 1;
    }
    let end = nameEnd;
    while (end < lowerSource.length && lowerSource[end] !== ">" && lowerSource[end] !== "<") {
      end += 1;
    }
    if (lowerSource[end] === "<") {
      cursor = end;
      continue;
    }
    if (lowerSource[end] !== ">") return null;
    const qualifiedName = lowerSource.slice(nameStart, nameEnd);
    const actualLocalName = qualifiedName.split(":").at(-1);
    if (isClosing === closing && actualLocalName === localName) {
      return {start, end};
    }
    cursor = start + 1;
  }
  return null;
}

function extractLoc(container, parseErrors, entry) {
  const lowerContainer = container.toLowerCase();
  const opening = findElementTag(container, lowerContainer, "loc", 0, false);
  const closing = opening
    ? findElementTag(container, lowerContainer, "loc", opening.end + 1, true)
    : null;
  if (!opening || !closing) {
    parseErrors.push(
      parseError("SITEMAP_LOC_MISSING", "Sitemap entry has no complete loc element", entry),
    );
    return null;
  }
  return decodeLoc(container.slice(opening.end + 1, closing.start), parseErrors, entry);
}

function normalizeHttpUrl(value, parseErrors, entry) {
  try {
    if (Buffer.byteLength(String(value)) > MAX_SITEMAP_URL_BYTES) throw new TypeError();
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError();
    if (url.username || url.password) throw new TypeError();
    url.hash = "";
    if (Buffer.byteLength(url.href) > MAX_SITEMAP_URL_BYTES) throw new TypeError();
    return url.href;
  } catch {
    parseErrors.push(
      parseError(
        "SITEMAP_LOC_INVALID",
        `loc must be an absolute credential-free http or https URL no longer than ${MAX_SITEMAP_URL_BYTES} bytes`,
        entry,
      ),
    );
    return null;
  }
}

function tagCounts(source, localName) {
  let opening = 0;
  let closing = 0;
  let malformed = false;
  let tagStart = -1;
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
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
      malformed = true;
      tagStart = index;
      continue;
    }
    if (character !== ">") continue;

    const raw = source.slice(tagStart + 1, index).trim();
    tagStart = -1;
    const isClosing = raw.startsWith("/");
    const nameSource = isClosing ? raw.slice(1).trimStart() : raw;
    const qualifiedName = /^[A-Za-z_][\w.:-]*/u.exec(nameSource)?.[0]?.toLowerCase();
    if (qualifiedName?.split(":").at(-1) !== localName) continue;
    if (isClosing) closing += 1;
    else opening += 1;
  }
  if (tagStart !== -1) malformed = true;
  return {opening, closing, malformed};
}

function findRootType(source) {
  let tagStart = -1;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
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
      tagStart = index;
      continue;
    }
    if (character !== ">") continue;
    const raw = source.slice(tagStart + 1, index).trim();
    tagStart = -1;
    if (!raw || raw.startsWith("/")) continue;
    const qualifiedName = /^[A-Za-z_][\w.:-]*/u.exec(raw)?.[0]?.toLowerCase();
    const localName = qualifiedName?.split(":").at(-1);
    if (localName === "urlset" || localName === "sitemapindex") return localName;
  }
  return null;
}

function *containers(source, localName) {
  const lowerSource = source.toLowerCase();
  let cursor = 0;
  while (cursor < source.length) {
    const opening = findElementTag(source, lowerSource, localName, cursor, false);
    if (!opening) return;
    const closing = findElementTag(source, lowerSource, localName, opening.end + 1, true);
    if (!closing) return;
    yield source.slice(opening.end + 1, closing.start);
    cursor = closing.end + 1;
  }
}

function stripComments(source, parseErrors) {
  const pieces = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("<!--", cursor);
    if (opening === -1) {
      pieces.push(source.slice(cursor));
      break;
    }
    pieces.push(source.slice(cursor, opening));
    const closing = source.indexOf("-->", opening + 4);
    if (closing === -1) {
      parseErrors.push(
        parseError("SITEMAP_COMMENT_UNCLOSED", "Sitemap contains an unclosed XML comment"),
      );
      break;
    }
    cursor = closing + 3;
  }
  return pieces.join("");
}

/**
 * Parse a sitemap urlset or sitemap index with a deliberately small XML
 * surface. DTD/entity expansion is rejected and no network-capable XML parser
 * is involved.
 */
export function parseSitemapXml(source, options = {}) {
  if (typeof source !== "string") {
    return emptyResult("invalid", 0, [
      parseError("SITEMAP_SOURCE_INVALID", "Sitemap source must be a string"),
    ]);
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_SITEMAP_BODY_BYTES;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_URLS;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_SITEMAP_BODY_BYTES
  ) {
    return emptyResult("invalid", Buffer.byteLength(source), [
      parseError(
        "SITEMAP_LIMIT_INVALID",
        `maxBodyBytes must be an integer between 1 and ${MAX_SITEMAP_BODY_BYTES}`,
      ),
    ]);
  }
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > MAX_SAMPLE_URLS) {
    return emptyResult("invalid", Buffer.byteLength(source), [
      parseError(
        "SITEMAP_LIMIT_INVALID",
        `sampleLimit must be an integer between 0 and ${MAX_SAMPLE_URLS}`,
      ),
    ]);
  }

  const byteLength = Buffer.byteLength(source);
  if (byteLength > maxBodyBytes) {
    return emptyResult("invalid", byteLength, [
      parseError(
        "SITEMAP_BODY_TOO_LARGE",
        `Sitemap is ${byteLength} bytes; configured maximum is ${maxBodyBytes}`,
      ),
    ]);
  }

  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) {
    return emptyResult("invalid", byteLength, [
      parseError(
        "SITEMAP_DTD_UNSUPPORTED",
        "DTD and custom entity declarations are not processed",
      ),
    ]);
  }

  const parseErrors = [];
  const xml = stripComments(source.replace(/^\uFEFF/, ""), parseErrors);
  const root = findRootType(xml);
  if (!root) {
    return emptyResult("invalid", byteLength, [
      ...parseErrors,
      parseError(
        "SITEMAP_ROOT_UNSUPPORTED",
        "Expected a urlset or sitemapindex root element",
      ),
    ]);
  }

  const type = root;
  const entryName = type === "urlset" ? "url" : "sitemap";
  const requestedLimit = options.maxEntries ??
    (type === "urlset" ? options.maxUrls : options.maxSitemaps);
  const maxEntries = requestedLimit ?? DEFAULT_MAX_SITEMAP_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_SITEMAP_ENTRIES) {
    return emptyResult("invalid", byteLength, [
      parseError(
        "SITEMAP_LIMIT_INVALID",
        `entry limit must be an integer between 0 and ${MAX_SITEMAP_ENTRIES}`,
      ),
    ]);
  }

  const rootCounts = tagCounts(xml, type);
  if (rootCounts.closing === 0) {
    parseErrors.push(
      parseError("SITEMAP_ROOT_UNCLOSED", `${type} root element is not closed`),
    );
  }

  const counts = tagCounts(xml, entryName);
  if (counts.malformed) {
    parseErrors.push(
      parseError("SITEMAP_TAG_UNCLOSED", "Sitemap contains an unclosed XML tag"),
    );
  }
  if (counts.opening !== counts.closing) {
    parseErrors.push(
      parseError(
        "SITEMAP_ENTRY_TAG_MISMATCH",
        `${entryName} opening/closing tag counts differ (${counts.opening}/${counts.closing})`,
      ),
    );
  }

  const entries = [];
  let entryIndex = 0;
  let truncated = false;
  let parseErrorsTruncated = false;
  for (const container of containers(xml, entryName)) {
    entryIndex += 1;
    if (parseErrors.length >= MAX_PARSE_ERRORS) {
      parseErrorsTruncated = true;
      truncated = true;
      break;
    }
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const loc = extractLoc(container, parseErrors, entryIndex);
    if (!loc) continue;
    const normalized = normalizeHttpUrl(loc, parseErrors, entryIndex);
    if (normalized) entries.push(normalized);
  }

  if (counts.opening > maxEntries || truncated) {
    truncated = true;
    if (parseErrors.length < MAX_PARSE_ERRORS) {
      parseErrors.push(
        parseError(
          "SITEMAP_ENTRY_LIMIT",
          `Sitemap entries exceed the configured maximum of ${maxEntries}`,
        ),
      );
    } else {
      parseErrorsTruncated = true;
    }
  }

  const rootIsComplete = rootCounts.closing > 0 && !rootCounts.malformed;
  const structuralFailure =
    !rootIsComplete || counts.malformed || counts.opening !== counts.closing;
  const status = structuralFailure && entries.length === 0
    ? "invalid"
    : parseErrors.length
      ? "partial"
      : "ok";
  const urls = type === "urlset" ? entries : [];
  const childSitemaps = type === "sitemapindex" ? entries : [];
  return {
    status,
    type,
    byte_length: byteLength,
    url_count: urls.length,
    child_sitemap_count: childSitemaps.length,
    urls,
    child_sitemaps: childSitemaps,
    sample_urls: entries.slice(0, sampleLimit),
    parse_errors: parseErrors,
    parse_error_count: parseErrors.length,
    parse_errors_truncated: parseErrorsTruncated,
    truncated,
  };
}

export {
  DEFAULT_MAX_SITEMAP_BODY_BYTES,
  DEFAULT_MAX_SITEMAP_ENTRIES,
  DEFAULT_SAMPLE_URLS,
  MAX_SAMPLE_URLS,
  MAX_SITEMAP_BODY_BYTES,
  MAX_SITEMAP_ENTRIES,
  MAX_SITEMAP_URL_BYTES,
  MAX_PARSE_ERRORS,
};
