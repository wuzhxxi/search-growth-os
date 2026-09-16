const OPTION_SPECS = Object.freeze({
  "--max-pages": ["max_pages", 1, 1_000],
  "--concurrency": ["concurrency", 1, 10],
  "--timeout-ms": ["timeout_ms", 100, 60_000],
  "--max-redirects": ["max_redirects", 0, 10],
  "--max-body-bytes": ["max_body_bytes", 1_024, 5_242_880],
  "--max-sitemaps": ["max_sitemaps", 1, 100],
  "--max-sitemap-depth": ["max_sitemap_depth", 0, 5],
  "--max-sitemap-urls": ["max_sitemap_urls", 1, 100_000],
  "--max-links-per-page": ["max_links_per_page", 1, 500],
});

function parseIntegerOption(name, rawValue, minimum, maximum) {
  if (!/^(?:0|[1-9]\d*)$/u.test(rawValue ?? "")) {
    throw new TypeError(`${name} requires an integer value`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseAuditOptions(args) {
  const positionals = [];
  const configuration = {};
  let json = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equalsAt = token.indexOf("=");
      const name = equalsAt === -1 ? token : token.slice(0, equalsAt);
      const spec = OPTION_SPECS[name];
      if (!spec) throw new TypeError(`Unknown option: ${name}`);
      const rawValue = equalsAt === -1 ? args[++index] : token.slice(equalsAt + 1);
      const [key, minimum, maximum] = spec;
      configuration[key] = parseIntegerOption(name, rawValue, minimum, maximum);
      continue;
    }
    positionals.push(token);
  }

  return { positionals, configuration, json, help };
}

export const AUDIT_OPTION_HELP = Object.freeze([
  "--json                  Emit the complete Audit Run as JSON",
  "--max-pages N           Crawl at most N pages (1-1000)",
  "--concurrency N          Use at most N requests at once (1-10)",
  "--timeout-ms N           Per-request timeout (100-60000)",
  "--max-redirects N        Follow at most N redirects (0-10)",
  "--max-body-bytes N       Read at most N response bytes (1024-5242880)",
  "--max-sitemaps N         Inspect at most N sitemap documents (1-100)",
  "--max-sitemap-depth N    Follow nested sitemap indexes to depth N (0-5)",
  "--max-sitemap-urls N     Collect at most N sitemap URLs (1-100000)",
  "--max-links-per-page N   Queue at most N internal links per page (1-500)",
]);
