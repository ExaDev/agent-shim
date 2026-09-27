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
  listProviders,
  loadProvider,
  ProviderAlreadyExistsError,
  providerExists,
  ProviderNotFoundError,
  readProvider,
  removeProvider,
  resolveProvider,
} from "./providers";

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

  describe("addProvider", () => {
    it("writes a provider file that reads back identically", () => {
      const provider = addProvider(paths, "z", {
        displayName: "GLM",
        baseUrl: "https://api.z.ai/api/anthropic",
        tokenEnv: "Z_API_TOKEN",
        env: { ANTHROPIC_MODEL: "glm-4.6" },
      });
      expect(provider).toEqual({
        displayName: "GLM",
        baseUrl: "https://api.z.ai/api/anthropic",
        tokenEnv: "Z_API_TOKEN",
        env: { ANTHROPIC_MODEL: "glm-4.6" },
      });
      expect(readProvider(paths, "z")).toEqual(provider);
      expect(providerExists(paths, "z")).toBe(true);
    });

    it("throws ProviderAlreadyExistsError when the provider already exists", () => {
      addProvider(paths, "z", { displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" });
      expect(() => addProvider(paths, "z", { displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" })).toThrow(
        ProviderAlreadyExistsError,
      );
    });

    it("throws InvalidProviderNameError for a name that could escape the providers directory", () => {
      expect(() => addProvider(paths, "-bad-start", { displayName: "x", baseUrl: "https://a.example", tokenEnv: "T" })).toThrow(
        InvalidProviderNameError,
      );
      expect(() => addProvider(paths, "../escape", { displayName: "x", baseUrl: "https://a.example", tokenEnv: "T" })).toThrow(
        InvalidProviderNameError,
      );
    });

    it("throws ConfigValidationError, not a raw ZodError, for a baseUrl that is not a URL", () => {
      expect(() => addProvider(paths, "z", { displayName: "GLM", baseUrl: "not-a-url", tokenEnv: "Z_API_TOKEN" })).toThrow(
        ConfigValidationError,
      );
    });
  });

  describe("listProviders", () => {
    it("lists providers sorted by name and skips a file that fails validation", () => {
      addProvider(paths, "z", { displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" });
      addProvider(paths, "m", { displayName: "MiniMax", baseUrl: "https://api.minimax.io", tokenEnv: "MINIMAX_API_KEY" });
      fs.mkdirSync(paths.providersDir, { recursive: true });
      fs.writeFileSync(path.join(paths.providersDir, "broken.json"), "{\"displayName\": \"no baseUrl\"}");

      const names = listProviders(paths).map((entry) => entry.name);
      expect(names).toEqual(["m", "z"]);
    });

    it("returns an empty list when no providers directory exists at all", () => {
      expect(listProviders(paths)).toEqual([]);
    });
  });

  describe("removeProvider", () => {
    it("deletes the provider file and then reports it as gone", () => {
      addProvider(paths, "z", { displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" });
      removeProvider(paths, "z");
      expect(providerExists(paths, "z")).toBe(false);
      expect(() => {
        removeProvider(paths, "z");
      }).toThrow(ProviderNotFoundError);
    });
  });

  describe("loadProvider", () => {
    it("reads through an injected FsPort and returns undefined for a missing provider", () => {
      addProvider(paths, "z", { displayName: "GLM", baseUrl: "https://api.z.ai", tokenEnv: "Z_API_TOKEN" });
      const port = tempFsPort();
      expect(loadProvider(paths.providersDir, "z", port)?.displayName).toBe("GLM");
      expect(loadProvider(paths.providersDir, "missing", port)).toBeUndefined();
    });
  });

  describe("resolveProvider", () => {
    const zInput = { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" };

    it("returns undefined when nothing selected a provider", () => {
      expect(resolveProvider({ paths, port: tempFsPort(), env: {} })).toBeUndefined();
    });

    it("resolves the --provider flag into a definition plus the token read from the environment", () => {
      addProvider(paths, "z", zInput);
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "tok-z" }, cliProvider: "z" });
      expect(result).toEqual({
        ok: true,
        provider: { name: "z", definition: { displayName: "GLM", baseUrl: "https://api.z.ai/api/anthropic", tokenEnv: "Z_API_TOKEN" }, token: "tok-z" },
      });
    });

    it("resolves a fixed-credential provider without tokenEnv, taking the token from its env", () => {
      addProvider(paths, "codex", {
        displayName: "Codex",
        baseUrl: "http://127.0.0.1:18789",
        env: { ANTHROPIC_AUTH_TOKEN: "codex-subscription-local", ANTHROPIC_API_KEY: "" },
      });
      const result = resolveProvider({ paths, port: tempFsPort(), env: {}, cliProvider: "codex" });
      expect(result).toEqual({
        ok: true,
        provider: {
          name: "codex",
          definition: {
            displayName: "Codex",
            baseUrl: "http://127.0.0.1:18789",
            env: { ANTHROPIC_AUTH_TOKEN: "codex-subscription-local", ANTHROPIC_API_KEY: "" },
          },
          token: "codex-subscription-local",
        },
      });
    });

    it("falls back to the cascade's launch.provider selection when no flag was given", () => {
      addProvider(paths, "z", zInput);
      const cascade = {
        home: root,
        loadProfile: () => undefined,
        cliOverride: { launch: { provider: "z" } },
      };
      const result = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "tok-z" }, cascade });
      expect(result?.ok).toBe(true);
    });

    it("refuses an unknown provider with a message naming the known providers", () => {
      addProvider(paths, "z", zInput);
      const result = resolveProvider({ paths, port: tempFsPort(), env: {}, cliProvider: "missing" });
      expect(result).toEqual({
        ok: false,
        status: 1,
        message: 'claude-use: no provider named "missing". Known providers: z.',
      });
    });

    it("refuses with status 64 when the token environment variable is unset or empty", () => {
      addProvider(paths, "z", zInput);
      const unset = resolveProvider({ paths, port: tempFsPort(), env: {}, cliProvider: "z" });
      expect(unset).toEqual({
        ok: false,
        status: 64,
        message: "claude-use: provider z needs Z_API_TOKEN set in your environment",
      });
      const empty = resolveProvider({ paths, port: tempFsPort(), env: { Z_API_TOKEN: "" }, cliProvider: "z" });
      expect(empty).toEqual(unset);
    });
  });
});
