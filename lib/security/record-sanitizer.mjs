const ABSOLUTE_WEB_URL = /https?:\/\/[^\s<>"']+/giu;
const SENSITIVE_QUERY_NAME = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|code|credential|id[_-]?token|jwt|key|oauth[_-]?token|pass(?:word|wd)?|secret|session(?:id)?|sig(?:nature)?|token|x-(?:amz|goog)-(?:credential|signature|security-token))$/iu;

function sanitizedParsedUrl(url, {relative = false} = {}) {
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (!SENSITIVE_QUERY_NAME.test(name)) continue;
    url.searchParams.set(name, "[REDACTED]");
    changed = true;
  }
  if (!changed) return null;
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

export function sanitizeUrlForRecord(value) {
  const source = String(value ?? "");
  try {
    const url = new URL(source);
    return sanitizedParsedUrl(url) ?? source;
  } catch {
    if (source.startsWith("/")) {
      try {
        const url = new URL(source, "https://redaction.invalid");
        return sanitizedParsedUrl(url, {relative: true}) ?? source;
      } catch {
        // Fall through to credential-like prefix redaction.
      }
    }
    return source.replace(
      /^([a-z][a-z\d+.-]*:\/\/)[^/?#@]*@/iu,
      "$1[REDACTED]@",
    );
  }
}

export function sanitizeTextForRecord(value) {
  const source = String(value ?? "");
  const exact = sanitizeUrlForRecord(source);
  if (exact !== source) return exact;
  return source.replace(ABSOLUTE_WEB_URL, (candidate) => sanitizeUrlForRecord(candidate));
}

export function sanitizeRecord(value) {
  if (typeof value === "string") return sanitizeTextForRecord(value);
  if (Array.isArray(value)) return value.map(sanitizeRecord);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) output[key] = sanitizeRecord(nested);
  return output;
}
