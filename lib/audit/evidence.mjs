import { createHash } from "node:crypto";

const EVIDENCE_STATES = new Set([
  "VERIFIED",
  "PROVIDED",
  "OBSERVED",
  "INFERRED",
  "HYPOTHESIS",
  "UNKNOWN",
]);

export function createEvidence({ state = "OBSERVED", source, observedAt, notes }) {
  if (!EVIDENCE_STATES.has(state)) {
    throw new TypeError(`Unsupported evidence state: ${state}`);
  }
  return {
    state,
    source: String(source ?? "unknown"),
    observed_at: observedAt ?? null,
    notes: String(notes ?? ""),
  };
}

function findingId(prefix, assets, title) {
  const digest = createHash("sha256")
    .update(JSON.stringify([prefix, assets, title]))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}-${digest}`;
}

export function createFinding({
  prefix = "technical",
  title,
  evidence,
  businessImpact,
  confidence = "medium",
  effort = "medium",
  affectedAssets = [],
  recommendation,
  validationMethod,
}) {
  const assets = [...new Set(affectedAssets.map(String))];
  return {
    id: findingId(prefix, assets, title),
    title,
    agent: "aeo",
    evidence,
    business_impact: businessImpact,
    confidence,
    effort,
    affected_assets: assets,
    recommendation,
    validation_method: validationMethod,
  };
}

export function evidenceForObservation(source, observedAt, notes, state = "OBSERVED") {
  return [createEvidence({ state, source, observedAt, notes })];
}
