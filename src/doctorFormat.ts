import type { DoctorReport, DoctorSection, DoctorSeverity } from "./doctorReport";

const SECTION_TITLES: Readonly<Record<DoctorSection, string>> = {
  models: "Virtual models",
  "route-overrides": "Route overrides",
  "ambient-credential": "Ambient-credential exposure",
  "binary-discovery": "Claude Code binary discovery",
  "claude-shim": "`claude` command shim",
  "path-resolution": "PATH resolution",
  "legacy-name": "Former `claude-use` name",
  "config-profile": "Configuration profiles",
  identity: "Identities",
  "sign-in": "Sign-in",
  "farm-links": "Farm links",
  pool: "Pools",
  provider: "Providers",
  keychain: "macOS Keychain",
  "directory-rules": "Directory rules",
  "global-config": "Global config",
  headroom: "Headroom daemon",
  frontdoor: "Front door",
  "categories-local": "categories.local.json",
  "active-identity": "Active identity",
};

/** The order `formatDoctorReport` prints the sections in; every section in `DOCTOR_SECTIONS` is listed, or its findings would reach `--json` alone. */
const SECTION_ORDER: readonly DoctorSection[] = [
  "ambient-credential",
  "binary-discovery",
  "claude-shim",
  "path-resolution",
  "legacy-name",
  "config-profile",
  "identity",
  "sign-in",
  "farm-links",
  "pool",
  "provider",
  "keychain",
  "directory-rules",
  "global-config",
  "models",
  "headroom",
  "frontdoor",
  "categories-local",
  "active-identity",
];

function severityPrefix(severity: DoctorSeverity): string {
  switch (severity) {
    case "pass":
      return "[PASS]";
    case "warn":
      return "[WARN]";
    case "fail":
      return "[FAIL]";
    default:
      return severity satisfies never;
  }
}

/** Renders a full `DoctorReport` as plain text lines, one section header at a time, in the order `agent-shim doctor` prints them. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const section of SECTION_ORDER) {
    const sectionFindings = report.findings.filter((finding) => finding.section === section);
    if (sectionFindings.length === 0) {
      continue;
    }
    lines.push("", `${SECTION_TITLES[section]}:`);
    for (const finding of sectionFindings) {
      const subject = finding.subject === undefined ? "" : `${finding.subject}: `;
      lines.push(`  ${severityPrefix(finding.severity)} ${subject}${finding.message}`);
    }
  }
  const failCount = report.findings.filter((finding) => finding.severity === "fail").length;
  lines.push("", report.ok ? "All checks passed." : `${String(failCount)} check(s) failed.`);
  return lines;
}
