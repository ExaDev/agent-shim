import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config/load";
import type { FsPort } from "./launcher/ports";
import { buildLayoutPaths, type LayoutPaths } from "./paths";
import {
  addProvider,
  InvalidProviderNameError,
  LEGACY_LITERAL_PLACEHOLDER,
  legacyProviderConversion,
  LegacyProviderFileError,
  listProviders,
  loadProvider,
  ProviderAlreadyExistsError,
  providerExists,
  ProviderKindMismatchError,
  ProviderNotFoundError,
  readProvider,
  removeProvider,
  resolveProvider,
} from "./providers";
import { fakeCredentials } from "./test-helpers";

/** A minimal real-filesystem `FsPort` over the temp root, so `resolveProvider` is exercised against files `addProvider` actually wrote, the same way the real launcher reads them. */
function tempFsPort(): FsPort {
  return {
    readFileUtf8: (filePath) => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return undefined;
      }
    },
    readConfigFile: (filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      } catch {
        return undefined;
      }
    },
    readdir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

describe("providers", () => {
  let root: string;
  let paths: LayoutPaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "providers-test-"));
    paths = buildLayoutPaths(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const zInput = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", sources: [{ env: "Z_API_TOKEN" }] };

  describe("addProvider", () => {
    it("writes a provider file that reads back identically", () => {
      const provider = addProvider(paths, "z", { ...zInput, env: { ANTHROPIC_MODEL: "glm-4.6" } });
      expect(provider).toEqual({
        displayName: "GLM",
        baseUrl: "https://api.z.ai/api/anthropic",
        credential: { sources: [{ env: "Z_API_TOKEN" }] },
        env: { ANTHROPIC_MODEL: "glm-4.6" },
      });
      expect(readProvider(paths, "z")).toEqual(provider);
      expect(providerExists(paths, "z")).toBe(true);
    });

    it("persists an ordered source list and a target", () => {
      const provider = addProvider(paths, "anthropic-api", {
        displayName: "Anthropic API",
        baseUrl: "https://api.anthropic.com",
        sources: [{ env: "ANTHROPIC_KEY" }, { op: "op://vault/anthropic/key" }],
        target: "apiKey",
      });
      expect(readProvider(paths, "anthropic-api")?.credential).toEqual({ sources: [{ env: "ANTHROPIC_KEY" }, { op: "op://vault/anthropic/key" }], target: "apiKey" });
      expect(provider.credential.target).toBe("apiKey");
    });

    it("throws ProviderAlreadyExistsError when the provider already exists", () => {
      addProvider(paths, "z", zInput);
      expect(() => addProvider(paths, "z", zInput)).toThrow(ProviderAlreadyExistsError);
    });

    it("throws InvalidProviderNameError for a name that could escape the providers directory", () => {
      expect(() => addProvider(paths, "-bad-start", zInput)).toThrow(InvalidProviderNameError);
      expect(() => addProvider(paths, "../escape", zInput)).toThrow(InvalidProviderNameError);
    });

    it("writes a codex provider with no base URL, and its codex settings only when given", () => {
      const plain = addProvider(paths, "codex", { kind: "codex", displayName: "Codex", sources: [{ literal: "codex" }] });
      expect(plain).toEqual({ kind: "codex", displayName: "Codex", credential: { sources: [{ literal: "codex" }] } });
      const tuned = addProvider(paths, "codex-tuned", { kind: "codex", displayName: "Codex", sources: [{ literal: "codex" }], codex: { models: { sonnet: "gpt-x" }, effort: "high" } });
      expect(readProvider(paths, "codex-tuned")).toEqual(tuned);
      expect(tuned).toMatchObject({ codex: { models: { sonnet: "gpt-x" }, effort: "high" } });
    });

    it("refuses a base URL on a codex provider, a missing one on an http provider, and codex settings on an http provider", () => {
      expect(() => addProvider(paths, "c", { kind: "codex", displayName: "Codex", baseUrl: "https://x.example", sources: [{ literal: "x" }] })).toThrow(ProviderKindMismatchError);
      expect(() => addProvider(paths, "h", { displayName: "H", sources: [{ env: "X" }] })).toThrow(ProviderKindMismatchError);
      expect(() => addProvider(paths, "h", { ...zInput, codex: { effort: "high" } })).toThrow(ProviderKindMismatchError);
      expect(providerExists(paths, "c") || providerExists(paths, "h")).toBe(false);
    });

    it("throws ConfigValidationError, not a raw ZodError, for a baseUrl that is not a URL or an empty source list", () => {
      expect(() => addProvider(paths, "z", { ...zInput, baseUrl: "not-a-url" })).toThrow(ConfigValidationError);
      expect(() => addProvider(paths, "z", { ...zInput, sources: [] })).toThrow(ConfigValidationError);
    });
  });

  describe("listProviders", () => {
    it("lists providers sorted by name and skips a file that fails validation or is in the old format", () => {
      addProvider(paths, "z", zInput);
      addProvider(paths, "m", { ...zInput, displayName: "MiniMax" });
      fs.mkdirSync(paths.providersDir, { recursive: true });
      fs.writeFileSync(path.join(paths.providersDir, "broken.json"), "{\"displayName\": \"no baseUrl\"}");
      fs.writeFileSync(path.join(paths.providersDir, "old.json"), JSON.stringify({ displayName: "Old", baseUrl: "https://a.example", tokenEnv: "T" }));

      const names = listProviders(paths).map((entry) => entry.name);
      expect(names).toEqual(["m", "z"]);
    });

    it("returns an empty list when no providers directory exists at all", () => {
      expect(listProviders(paths)).toEqual([]);
    });
  });

  describe("removeProvider", () => {
    it("deletes the provider file and then reports it as gone", () => {
      addProvider(paths, "z", zInput);
      removeProvider(paths, "z");
      expect(providerExists(paths, "z")).toBe(false);
      expect(() => {
        removeProvider(paths, "z");
      }).toThrow(ProviderNotFoundError);
    });
  });

  describe("loadProvider", () => {
    it("reads through an injected FsPort and returns undefined for a missing provider", () => {
      addProvider(paths, "z", zInput);
      const port = tempFsPort();
      expect(loadProvider(paths.providersDir, "z", port)?.displayName).toBe("GLM");
      expect(loadProvider(paths.providersDir, "missing", port)).toBeUndefined();
    });

    it("refuses an old-format provider file with its exact replacement instead of a bare schema error", () => {
      fs.mkdirSync(paths.providersDir, { recursive: true });
      fs.writeFileSync(path.join(paths.providersDir, "z.json"), JSON.stringify({ displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" }));
      expect(() => loadProvider(paths.providersDir, "z", tempFsPort())).toThrow(LegacyProviderFileError);
      expect(() => readProvider(paths, "z")).toThrow(/uses tokenEnv, which a credential block replaced/);
    });
  });

  describe("legacyProviderConversion", () => {
    it("converts tokenEnv, authScheme and credential env entries, keeping every other field", () => {
      expect(
        legacyProviderConversion({
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api",
          tokenEnv: "OPENROUTER_API_KEY",
          authScheme: "apiKey",
          env: { ANTHROPIC_API_KEY: "", API_TIMEOUT_MS: "600000" },
        }),
      ).toEqual({
        fields: ["tokenEnv", "authScheme", "env.ANTHROPIC_API_KEY"],
        replacement: {
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api",
          credential: { sources: [{ env: "OPENROUTER_API_KEY" }], target: "apiKey" },
          env: { API_TIMEOUT_MS: "600000" },
        },
      });
    });

    it("converts tokenCommand to a command source", () => {
      expect(legacyProviderConversion({ displayName: "x", baseUrl: "https://a.example", tokenCommand: ["pass", "show", "x"] })?.replacement).toEqual({
        displayName: "x",
        baseUrl: "https://a.example",
        credential: { sources: [{ command: ["pass", "show", "x"] }] },
      });
    });

    it("converts a fixed env.ANTHROPIC_AUTH_TOKEN to a literal source without printing its value", () => {
      const conversion = legacyProviderConversion({
        displayName: "Codex",
        baseUrl: "http://127.0.0.1:18789",
        env: { ANTHROPIC_AUTH_TOKEN: "fixed-proxy-value", ANTHROPIC_API_KEY: "" },
      });
      expect(conversion?.replacement).toEqual({
        displayName: "Codex",
        baseUrl: "http://127.0.0.1:18789",
        credential: { sources: [{ literal: LEGACY_LITERAL_PLACEHOLDER }] },
      });
      expect(JSON.stringify(conversion)).not.toContain("fixed-proxy-value");
    });

    it("leaves a current-format or merely invalid file alone", () => {
      expect(legacyProviderConversion({ displayName: "x", baseUrl: "https://a.example", credential: { sources: [{ env: "T" }] } })).toBeUndefined();
      expect(legacyProviderConversion({ displayName: "x" })).toBeUndefined();
      expect(legacyProviderConversion("not an object")).toBeUndefined();
    });
  });

  describe("resolveProvider", () => {
    it("returns undefined when nothing selected a provider", () => {
      expect(resolveProvider({ paths, port: tempFsPort(), env: {}, credentials: fakeCredentials() })).toBeUndefined();
    });

    it("resolves the --provider flag into a definition plus the credential its block resolves to", () => {
      addProvider(paths, "z", zInput);
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "tok-z" }, credentials: fakeCredentials(), cliProvider: "z" });
      expect(result).toEqual({
        ok: true,
        provider: {
          name: "z",
          definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", credential: { sources: [{ env: "Z_API_TOKEN" }] } },
          credential: { target: "bearer", token: "tok-z", source: { env: "Z_API_TOKEN" }, warnings: [] },
        },
        warnings: [],
      });
    });

    it("resolves a literal-credential provider for a local proxy with nothing in the environment", () => {
      addProvider(paths, "codex", { displayName: "Codex", baseUrl: "http://127.0.0.1:18789", sources: [{ literal: "codex-local" }] });
      const result = resolveProvider({ paths, port: tempFsPort(), env: {}, credentials: fakeCredentials(), cliProvider: "codex" });
      expect(result).toMatchObject({ ok: true, provider: { credential: { token: "codex-local" } } });
    });

    it("falls back to the cascade's launch.provider selection when no flag was given", () => {
      addProvider(paths, "z", zInput);
      const cascade = {
        home: root,
        loadProfile: () => undefined,
        cliOverride: { launch: { provider: "z" } },
      };
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "tok-z" }, credentials: fakeCredentials(), cascade });
      expect(result?.ok).toBe(true);
    });

    it("refuses an unknown provider with a message naming the known providers", () => {
      addProvider(paths, "z", zInput);
      const result = resolveProvider({ paths, port: tempFsPort(), env: {}, credentials: fakeCredentials(), cliProvider: "missing" });
      expect(result).toEqual({
        ok: false,
        status: 1,
        message: 'agent-shim: no provider named "missing". Known providers: z.',
      });
    });

    it("refuses with status 64 naming every source when none yields a token", () => {
      addProvider(paths, "z", { ...zInput, sources: [{ env: "Z_API_TOKEN" }, { command: ["pass", "show", "z"] }] });
      const credentials = fakeCredentials({ command: { status: 1, stderr: "not in store" } });
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "" }, credentials, cliProvider: "z" });
      expect(result).toEqual({
        ok: false,
        status: 64,
        message: "agent-shim: provider z has no usable credential: env Z_API_TOKEN is unset or empty; command pass exited with status 1: not in store",
      });
    });

    it("refuses rather than launching without a credential when no credential port is wired", () => {
      addProvider(paths, "z", zInput);
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "tok-z" }, cliProvider: "z" });
      expect(result).toMatchObject({ ok: false, status: 1 });
    });
  });
});
