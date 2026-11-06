import type { Identity } from "../config/schema";
import type { DoctorIdentityInput, DoctorReport } from "../doctorReport";

/** Codex authentication must not be inferred from a Claude credentials file or Keychain entry. */
export function codexIdentityFindings(entry: DoctorIdentityInput, identity: Identity): DoctorReport["findings"] {
  const incompatible = identity.provider !== undefined || identity.credential !== undefined || identity.anchors !== undefined;
  return [
    { section: "identity", severity: incompatible ? "fail" : "pass", subject: entry.name, message: incompatible ? `${entry.name} is a Codex identity with Claude-only provider, credential or anchor settings.` : `${entry.name} is a valid Codex identity; its home is ${entry.farmRoot}.` },
    { section: "sign-in", severity: "warn", subject: entry.name, message: `Codex login not queried. Run agent-shim run --agent codex @${entry.name} login status to validate its isolated login.` },
  ];
}
