import {performance} from "node:perf_hooks";

const ISSUED_BUDGETS = new WeakSet();

export const AUDIT_REQUEST_BUDGET_LIMITS = Object.freeze({
  max_requests: 1_500,
  max_response_bytes: 64 * 1024 * 1024,
  max_duration_ms: 5 * 60 * 1_000,
});

export class RequestBudgetError extends Error {
  constructor(code, message, status = "unavailable") {
    super(message);
    this.name = "RequestBudgetError";
    this.code = code;
    this.status = status;
  }
}

function bounded(value, fallback, minimum, maximum, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

export function createRequestBudget({
  maxRequests,
  maxResponseBytes,
  maxDurationMs,
} = {}) {
  const started = performance.now();
  const max_requests = bounded(
    maxRequests,
    AUDIT_REQUEST_BUDGET_LIMITS.max_requests,
    1,
    AUDIT_REQUEST_BUDGET_LIMITS.max_requests,
    "maxRequests",
  );
  const max_response_bytes = bounded(
    maxResponseBytes,
    AUDIT_REQUEST_BUDGET_LIMITS.max_response_bytes,
    1_024,
    AUDIT_REQUEST_BUDGET_LIMITS.max_response_bytes,
    "maxResponseBytes",
  );
  const max_duration_ms = bounded(
    maxDurationMs,
    AUDIT_REQUEST_BUDGET_LIMITS.max_duration_ms,
    100,
    AUDIT_REQUEST_BUDGET_LIMITS.max_duration_ms,
    "maxDurationMs",
  );
  const budget = {
    kind: "search-growth-audit-request-budget",
    max_requests,
    max_response_bytes,
    max_duration_ms,
    requests_used: 0,
    response_bytes_used: 0,
    response_bytes_reserved: 0,
    exhausted: false,
    exhaustion_code: null,
    started_monotonic_ms: started,
    deadline_monotonic_ms: started + max_duration_ms,
  };
  ISSUED_BUDGETS.add(budget);
  return budget;
}

function failBudget(budget, code, message, status = "unavailable") {
  budget.exhausted = true;
  budget.exhaustion_code = code;
  throw new RequestBudgetError(code, message, status);
}

export function reserveRequestBudget(budget, requestedBodyBytes, requestedTimeoutMs) {
  if (!budget) {
    return {
      budget: null,
      reserved_bytes: 0,
      max_body_bytes: requestedBodyBytes,
      timeout_ms: requestedTimeoutMs,
      released: false,
    };
  }
  if (!ISSUED_BUDGETS.has(budget)) {
    throw new RequestBudgetError("AUDIT_BUDGET_INVALID", "Invalid shared request budget");
  }
  if (budget.exhausted) {
    const code = budget.exhaustion_code ?? "AUDIT_REQUEST_BUDGET_EXCEEDED";
    throw new RequestBudgetError(
      code,
      code === "AUDIT_DEADLINE_EXCEEDED"
        ? "Audit Run wall-clock budget was exhausted"
        : code === "AUDIT_BYTE_BUDGET_EXCEEDED"
          ? "Audit Run response-byte budget was exhausted"
          : "Audit Run request budget was exhausted",
      code === "AUDIT_DEADLINE_EXCEEDED" ? "timeout" : "unavailable",
    );
  }

  const remainingTime = Math.floor(budget.deadline_monotonic_ms - performance.now());
  if (remainingTime < 1) {
    failBudget(budget, "AUDIT_DEADLINE_EXCEEDED", "Audit Run wall-clock budget was exhausted", "timeout");
  }
  if (budget.requests_used >= budget.max_requests) {
    failBudget(budget, "AUDIT_REQUEST_BUDGET_EXCEEDED", "Audit Run request budget was exhausted");
  }
  const availableBytes =
    budget.max_response_bytes - budget.response_bytes_used - budget.response_bytes_reserved;
  if (availableBytes < 1) {
    failBudget(budget, "AUDIT_BYTE_BUDGET_EXCEEDED", "Audit Run response-byte budget was exhausted");
  }

  const reservedBytes = Math.min(requestedBodyBytes, availableBytes);
  budget.requests_used += 1;
  budget.response_bytes_reserved += reservedBytes;
  return {
    budget,
    reserved_bytes: reservedBytes,
    max_body_bytes: reservedBytes,
    timeout_ms: Math.max(1, Math.min(requestedTimeoutMs, remainingTime)),
    released: false,
  };
}

export function remainingRequestBudgetTime(reservation, requestedTimeoutMs) {
  if (!reservation?.budget) return requestedTimeoutMs;
  const budget = reservation.budget;
  if (!ISSUED_BUDGETS.has(budget)) {
    throw new RequestBudgetError("AUDIT_BUDGET_INVALID", "Invalid shared request budget");
  }
  if (budget.exhausted) {
    const code = budget.exhaustion_code ?? "AUDIT_REQUEST_BUDGET_EXCEEDED";
    throw new RequestBudgetError(
      code,
      code === "AUDIT_DEADLINE_EXCEEDED"
        ? "Audit Run wall-clock budget was exhausted"
        : code === "AUDIT_BYTE_BUDGET_EXCEEDED"
          ? "Audit Run response-byte budget was exhausted"
          : "Audit Run request budget was exhausted",
      code === "AUDIT_DEADLINE_EXCEEDED" ? "timeout" : "unavailable",
    );
  }
  const remainingTime = Math.floor(budget.deadline_monotonic_ms - performance.now());
  if (remainingTime < 1) {
    failBudget(
      budget,
      "AUDIT_DEADLINE_EXCEEDED",
      "Audit Run wall-clock budget was exhausted",
      "timeout",
    );
  }
  return Math.max(1, Math.min(requestedTimeoutMs, remainingTime));
}

export function releaseRequestBudget(reservation, responseBytes = 0) {
  if (!reservation || reservation.released) return;
  reservation.released = true;
  if (!reservation.budget) return;
  const budget = reservation.budget;
  budget.response_bytes_reserved = Math.max(
    0,
    budget.response_bytes_reserved - reservation.reserved_bytes,
  );
  const consumedBytes =
    Number.isSafeInteger(responseBytes) && responseBytes > 0 ? responseBytes : 0;
  budget.response_bytes_used += consumedBytes;
  if (budget.response_bytes_used >= budget.max_response_bytes) {
    budget.exhausted = true;
    budget.exhaustion_code ??= "AUDIT_BYTE_BUDGET_EXCEEDED";
  }
}

export function requestBudgetSnapshot(budget) {
  if (!budget) return null;
  if (
    !budget.exhausted &&
    performance.now() >= budget.deadline_monotonic_ms
  ) {
    budget.exhausted = true;
    budget.exhaustion_code = "AUDIT_DEADLINE_EXCEEDED";
  }
  return {
    max_requests: budget.max_requests,
    max_response_bytes: budget.max_response_bytes,
    max_duration_ms: budget.max_duration_ms,
    requests_used: budget.requests_used,
    response_bytes_used: budget.response_bytes_used,
    exhausted: budget.exhausted,
    exhaustion_code: budget.exhaustion_code,
  };
}
