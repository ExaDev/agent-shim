import { InvalidArgumentError } from "commander";

import { CredentialSourceSchema, type CredentialSource } from "../config/schema";

/** The `--credential` spellings, for help text: every kind's short form, and the JSON form that reaches every field. */
export const CREDENTIAL_SOURCE_SYNTAX =
  "env:<VAR>, file:<path>, command:<program and arguments>, op:<op://reference>, keychain:<service>[:<account>], literal:<placeholder>, or a JSON source object";

/**
 * Parses one `--credential` value into a credential source. No error message repeats the value itself, since a mistyped flag may well be a pasted token.
 *
 * The short form is `<kind>:<value>`, split on the first colon: `env:Z_API_TOKEN`, `file:~/.config/z.token`, `op:op://vault/item/field`, `literal:dummy`, `keychain:<service>` or `keychain:<service>:<account>` (so a service name cannot contain a colon), and `command:<argv>`, whose value is split on whitespace with no quoting. A value starting with `{` is a JSON source object exactly as a config file holds it, which is the form for anything the short form cannot say (a command argument containing spaces, `interactive`, `timeoutMs`). Either way the result is validated against `CredentialSourceSchema`, so the flag accepts exactly what a file does.
 */
function parseCredentialSource(spec: string): CredentialSource {
  let candidate: unknown;
  if (spec.startsWith("{")) {
    try {
      candidate = JSON.parse(spec);
    } catch (error) {
      throw new InvalidArgumentError(`a JSON credential source is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const colon = spec.indexOf(":");
    if (colon === -1) {
      throw new InvalidArgumentError(`the credential source names no kind. Expected ${CREDENTIAL_SOURCE_SYNTAX}.`);
    }
    const kind = spec.slice(0, colon);
    const value = spec.slice(colon + 1);
    switch (kind) {
      case "env":
      case "file":
      case "op":
      case "literal":
        candidate = { [kind]: value };
        break;
      case "keychain": {
        const accountColon = value.indexOf(":");
        candidate = {
          keychain: accountColon === -1 ? { service: value } : { service: value.slice(0, accountColon), account: value.slice(accountColon + 1) },
        };
        break;
      }
      case "command":
        candidate = { command: value.split(/\s+/).filter((word) => word !== "") };
        break;
      default:
        throw new InvalidArgumentError(`the credential source's kind is not one of env, file, command, op, keychain or literal. Expected ${CREDENTIAL_SOURCE_SYNTAX}.`);
    }
  }
  const parsed = CredentialSourceSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidArgumentError(`not a valid credential source: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

/** Commander repeatable-option collector for `--credential`: each occurrence appends one source, preserving the order given, which is the order sources are tried in. */
export function collectCredentialSource(value: string, previous: readonly CredentialSource[] = []): CredentialSource[] {
  return [...previous, parseCredentialSource(value)];
}
