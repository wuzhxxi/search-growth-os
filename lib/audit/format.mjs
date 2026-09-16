export function formatAuditRun(run) {
  const lines = [
    `Search Growth OS ${run.kind} audit`,
    `Run: ${run.run_id}`,
    `Target: ${run.target}`,
    `Observed: ${run.timestamp}`,
    `Status: ${run.summary.status}`,
    `Evidence: ${run.summary.evidence_count}`,
    `Findings: ${run.summary.finding_count}`,
    `Errors: ${run.summary.error_count}`,
  ];

  if (Number.isInteger(run.summary.pages_crawled)) {
    lines.push(`Pages crawled: ${run.summary.pages_crawled}`);
  }
  if (Number.isInteger(run.summary.sitemaps_checked)) {
    lines.push(`Sitemaps checked: ${run.summary.sitemaps_checked}`);
  }

  if (run.findings.length) {
    lines.push("", "Findings:");
    for (const finding of run.findings) {
      lines.push(`- [${finding.confidence}] ${finding.title}`);
      if (finding.affected_assets.length) lines.push(`  Assets: ${finding.affected_assets.join(", ")}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
  }

  if (run.errors.length) {
    lines.push("", "Errors / unavailable evidence:");
    for (const error of run.errors) {
      lines.push(`- ${error.code}${error.adapter ? ` (${error.adapter})` : ""}: ${error.message}`);
    }
  }

  lines.push("", "This audit reports observed technical evidence. It does not establish ranking, citation, traffic, or conversion impact.");
  return `${lines.join("\n")}\n`;
}
