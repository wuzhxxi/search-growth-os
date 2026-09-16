const STATUS_VALUES = [
  "ok",
  "partial",
  "UNKNOWN",
  "unavailable",
  "timeout",
  "blocked",
  "invalid",
];

export const ADAPTER_STATUSES = Object.freeze([...STATUS_VALUES]);

const STATUS_SET = new Set(STATUS_VALUES);

function cloneArray(value, fallback = []) {
  return Array.isArray(value) ? [...value] : [...fallback];
}

export function adapterError(code, message, details = {}) {
  const error = {
    code: String(code || "UNKNOWN_ERROR"),
    message: String(message || "Unknown adapter error"),
  };

  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) error[key] = value;
  }

  return error;
}

export function createAdapterResult({
  adapter,
  status,
  input = null,
  output = null,
  evidence = [],
  observedAt = new Date().toISOString(),
  errors = [],
} = {}) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("adapter metadata is required");
  }
  if (!STATUS_SET.has(status)) {
    throw new TypeError(`unsupported adapter status: ${String(status)}`);
  }

  for (const field of ["id", "name", "version"]) {
    if (typeof adapter[field] !== "string" || adapter[field].length === 0) {
      throw new TypeError(`adapter.${field} must be a non-empty string`);
    }
  }

  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    capabilities: cloneArray(adapter.capabilities),
    input,
    output,
    evidence: cloneArray(evidence),
    observed_at: observedAt,
    errors: cloneArray(errors),
    status,
  };
}
