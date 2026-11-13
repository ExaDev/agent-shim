import { describe, expect, it } from "vitest";

import { ConfigFileNotJsonError, ConfigValidationError } from "../config/load";
import type { FsPort } from "../launcher/ports";
import { createProviderReads } from "./providerReads";

const DIR = "/state/providers";

/** A providers directory listing `z`, whose file the reader fails on with `error`, as the real reader fails on a damaged file. */
function failingWith(error: Error): FsPort {
  return {
    sameDirectory: () => false,
    readFileUtf8: () => undefined,
    readdir: (dir) => (dir === DIR ? ["z.json"] : []),
    readConfigFile: () => {
      throw error;
    },
  };
}

describe("a provider file the reads cannot use", () => {
  it.each<[string, Error, string]>([
    ["not JSON", new ConfigFileNotJsonError(`${DIR}/z.json`), "not valid JSON"],
    ["another shape", new ConfigValidationError(`${DIR}/z.json`, [{ code: "invalid_type", expected: "string", path: ["displayName"], message: "Invalid input", input: 5 }]), "displayName"],
  ])("is reported as %s by its fault, never by the file's path", (_label, error, fault) => {
    const reads = createProviderReads({ fs: failingWith(error), providersDir: DIR });
    const found = reads.lookupProvider("z");
    const reason = found.kind === "invalid" ? found.reason : "";
    expect(reason).toContain('provider "z" cannot be used because its file is invalid');
    expect(reason).toContain(fault);
    expect(reason).not.toContain(DIR);
    expect(reads.providerFaultOf("z")).toBe(reason);
    expect(reads.selectorTarget("z", { kind: "none" }, {})).toEqual({ refusal: reason });
  });
});
