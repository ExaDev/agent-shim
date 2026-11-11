import { lookupKeychainService } from "./checkReport";
import type { DoctorIdentityInput, DoctorSection, DoctorSeverity } from "./doctorReport";
import type { RunPort } from "./launcher/ports";

/** What the Keychain section reports: that the check is skipped off macOS, else one informational line for each Claude identity saying whether its Keychain item is found. A Codex identity has no Keychain item to look for. */
export function pushKeychainFindings(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, platform: string, run: RunPort | undefined, identities: readonly DoctorIdentityInput[], agentOf: ReadonlyMap<string, "claude" | "codex">): void {
  if (platform !== "darwin" || run === undefined) {
    push("keychain", "pass", "Skipped (not macOS).");
    return;
  }
  for (const entry of identities) {
    if (agentOf.get(entry.name) === "codex") continue;
    const result = lookupKeychainService(run, entry.farmRoot);
    // Informational: whether the identity is signed in is the sign-in section's finding, which also counts a credentials file that stands in for the Keychain item.
    push("keychain", "pass", result.found ? result.note : `${result.note} The sign-in section reports whether a login is stored elsewhere.`, entry.name);
  }
}
