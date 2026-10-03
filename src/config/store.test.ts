import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ConfigValidationError } from "./load";
import { applyPatch, nodeStoreFs, readJson, writeJsonAtomic, writeTextAtomic, type StoreFs } from "./store";

const schema = z.strictObject({
  name: z.string().min(1),
  count: z.number().optional(),
});

describe("store.ts", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-shim-store-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("readJson", () => {
    it("returns undefined when the file does not exist", () => {
      expect(readJson(path.join(dir, "missing.json"), schema)).toBeUndefined();
    });

    it("parses and validates an existing file", () => {
      const filePath = path.join(dir, "identity.json");
      fs.writeFileSync(filePath, JSON.stringify({ name: "work" }));
      expect(readJson(filePath, schema)).toEqual({ name: "work" });
    });

    it("throws ConfigValidationError for a file that fails validation", () => {
      const filePath = path.join(dir, "bad.json");
      fs.writeFileSync(filePath, JSON.stringify({ count: "not-a-number" }));
      expect(() => readJson(filePath, schema)).toThrow(ConfigValidationError);
    });
  });

  describe("writeTextAtomic / writeJsonAtomic", () => {
    it("writes new content that can be read back", () => {
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme" });
      expect(readJson(filePath, schema)).toEqual({ name: "acme" });
    });

    it("never leaves a stray temp file behind after a successful write", () => {
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme" });
      const entries = fs.readdirSync(dir);
      expect(entries).toEqual(["profile.json"]);
    });

    it("creates missing parent directories", () => {
      const filePath = path.join(dir, "nested", "deep", "identity.json");
      writeJsonAtomic(filePath, { name: "nested-one" });
      expect(readJson(filePath, schema)).toEqual({ name: "nested-one" });
    });

    it("overwrites existing content rather than merging", () => {
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme", count: 3 });
      writeJsonAtomic(filePath, { name: "widget" });
      expect(readJson(filePath, schema)).toEqual({ name: "widget" });
    });

    it("leaves the original file completely untouched when the rename step fails (simulated crash)", () => {
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "original" });
      const originalContents = fs.readFileSync(filePath, "utf8");

      const crashingRenameFs: StoreFs = {
        ...nodeStoreFs,
        renameSync: () => {
          throw new Error("simulated crash between temp-write and rename");
        },
      };

      expect(() => { writeJsonAtomic(filePath, { name: "should-never-land" }, crashingRenameFs); }).toThrow(
        "simulated crash",
      );

      // The original file must be byte-for-byte untouched — the whole point of writing to a temp file first.
      expect(fs.readFileSync(filePath, "utf8")).toBe(originalContents);

      // The temp file must not be left behind either — writeTextAtomic cleans it up when the rename fails.
      const entries = fs.readdirSync(dir);
      expect(entries).toEqual(["profile.json"]);
    });

    it("uses a temp file located in the same directory as the destination, not a system temp dir", () => {
      const filePath = path.join(dir, "profile.json");
      const seenTempPaths: string[] = [];
      const observingFs: StoreFs = {
        ...nodeStoreFs,
        writeFileUtf8: (tempPath, contents) => {
          seenTempPaths.push(tempPath);
          nodeStoreFs.writeFileUtf8(tempPath, contents);
        },
      };
      writeJsonAtomic(filePath, { name: "acme" }, observingFs);
      expect(seenTempPaths).toHaveLength(1);
      const [tempPath] = seenTempPaths;
      if (tempPath === undefined) {
        throw new Error("Expected at least one observed temp path.");
      }
      expect(path.dirname(tempPath)).toBe(dir);
    });

    it("writeTextAtomic writes plain text, not JSON-wrapped", () => {
      const filePath = path.join(dir, "active-identity");
      writeTextAtomic(filePath, "work\n");
      expect(fs.readFileSync(filePath, "utf8")).toBe("work\n");
    });
  });

  describe("applyPatch", () => {
    it("merges a patch into an existing file and writes it back", () => {
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme", count: 1 });
      const result = applyPatch(filePath, schema, { count: 2 });
      expect(result).toEqual({ name: "acme", count: 2 });
      expect(readJson(filePath, schema)).toEqual({ name: "acme", count: 2 });
    });

    it("falls back to provided defaults when the file does not exist yet", () => {
      const filePath = path.join(dir, "new-profile.json");
      const result = applyPatch(filePath, schema, { count: 5 }, { defaults: { name: "fresh" } });
      expect(result).toEqual({ name: "fresh", count: 5 });
      expect(readJson(filePath, schema)).toEqual({ name: "fresh", count: 5 });
    });

    it("throws when the file does not exist and no defaults were given", () => {
      const filePath = path.join(dir, "missing.json");
      expect(() => applyPatch(filePath, schema, { count: 1 })).toThrow(/does not exist yet/);
    });

    it("throws ConfigValidationError when the merged result fails validation", () => {
      const refinementSchema = z.strictObject({ name: z.string().min(1), count: z.number().positive().optional() });
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme", count: 5 });
      expect(() => applyPatch(filePath, refinementSchema, { count: -1 })).toThrow(ConfigValidationError);
    });

    it("does not mutate the on-disk file at all when the patch fails validation", () => {
      const refinementSchema = z.strictObject({ name: z.string().min(1), count: z.number().positive().optional() });
      const filePath = path.join(dir, "profile.json");
      writeJsonAtomic(filePath, { name: "acme", count: 5 });
      const before = fs.readFileSync(filePath, "utf8");
      expect(() => applyPatch(filePath, refinementSchema, { count: -1 })).toThrow();
      expect(fs.readFileSync(filePath, "utf8")).toBe(before);
    });

    it("performs only a shallow merge — a nested-object patch key replaces the whole nested object", () => {
      const nestedSchema = z.strictObject({
        categories: z.strictObject({ history: z.boolean().optional(), knowledge: z.boolean().optional() }),
      });
      const filePath = path.join(dir, "nested.json");
      writeJsonAtomic(filePath, { categories: { history: true, knowledge: true } });
      const result = applyPatch(filePath, nestedSchema, { categories: { history: false } });
      // Shallow merge: "categories" as a whole is replaced by the patch's own "categories" value, not merged key-by-key — "knowledge" is gone because the caller didn't carry it forward.
      expect(result).toEqual({ categories: { history: false } });
    });
  });
});
