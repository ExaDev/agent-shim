import type { DoctorSection, DoctorSeverity } from "./doctorReport";
import type { DanglingFarmLink } from "./launcher/farm";

/** One identity's farm as the farm-links section reads it: the links in it that lead nowhere (`danglingFarmLinks`). */
export interface DoctorFarmLinksInput {
  /** The identity's name, which the finding is filed under and the remedy names. */
  readonly name: string;
  /** Its id, the directory under `identities/` the farm is. */
  readonly id: string;
  readonly dangling: readonly DanglingFarmLink[];
}

/** The sentence saying what a dangling link breaks and how the farm is brought up to date, for an identity of `agent` named `name`. */
function remedy(agent: "claude" | "codex", name: string, rel: string): string {
  if (agent === "codex") {
    return `Codex cannot write through it. A launch with \`agent-shim run --agent codex @${name}\` resyncs the farm and leaves the link out.`;
  }
  const lost = rel === "sessions" ? " (an interactive session's record under sessions/ is lost, so the session is missing from `claude agents`)" : "";
  return (
    `Claude Code cannot write through it${lost}. A launch through agent-shim resyncs the farm and leaves the link out, but a session started with this directory as CLAUDE_CONFIG_DIR does not. ` +
    `Run \`agent-shim identity resync ${name}\` in the directory those sessions start in to bring the farm up to date without launching.`
  );
}

/**
 * What the farm-links section reports: a warning for each farm link that leads nowhere, naming the identity, the entry, where the link points when its manifest records it, what that breaks and what brings the farm up to date, or one pass line when no identity's farm has such a link. A warning, as the launch's own `SHARED_ENTRY_DANGLING` is: the next resync of the farm repairs it, and nothing is lost meanwhile but what the harness could not write. An identity whose `identity.json` cannot be read is taken to be a Claude Code identity, the default agent.
 */
export function pushFarmLinkFindings(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, farms: readonly DoctorFarmLinksInput[], agentOf: ReadonlyMap<string, "claude" | "codex">): void {
  let found = false;
  for (const farm of farms) {
    for (const link of farm.dangling) {
      found = true;
      const points = link.target === undefined ? "" : ` to ${link.target}`;
      push("farm-links", "warn", `identities/${farm.id}/${link.rel} is a farm link${points} that leads nowhere, so ${remedy(agentOf.get(farm.name) ?? "claude", farm.name, link.rel)}`, farm.name);
    }
  }
  if (!found) {
    push("farm-links", "pass", "Every identity's farm links lead somewhere.");
  }
}
