#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rewrites the `$id` of every generated schema in `schema/*.schema.json` to the real, version-pinned GitHub Release asset URL for the given tag: `https://github.com/ExaDev/agent-shim/releases/download/<tag>/<file>`.
 *
 * This is deliberately different from install.sh's own `releases/latest/download/...` URL: the installer always wants the newest release, but a schema an editor references from a config file's own `$schema` field must stay stable at whatever version that config was written against — it must never shift underfoot on a later release the way `latest` would.
 *
 * Run at publish time only (from `release.yml`, right before the schema files are uploaded as release assets), never as part of `pnpm schema` — `scripts/gen-schema.mts` writes a placeholder `$id` with no notion of a release tag, and this script's rewrite is a separate, deliberate step layered on top of that output.
 *
 * Usage: node scripts/stamp-schema-ids.mts <tag> The tag may also come from the `GITHUB_REF_NAME` environment variable (as GitHub Actions sets it for a tag-triggered workflow run), used when no argv tag is given.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const schemaDir = path.join(rootDir, "schema");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTag(): string {
  const argTag = process.argv[2];
  if (argTag !== undefined && argTag.length > 0) {
    return argTag;
  }
  const envTag = process.env.GITHUB_REF_NAME;
  if (envTag !== undefined && envTag.length > 0) {
    return envTag;
  }
  throw new Error(
    "No release tag given. Pass one as the first argument (node scripts/stamp-schema-ids.mts v1.2.3) or set GITHUB_REF_NAME.",
  );
}

function main(): void {
  const tag = resolveTag();
  const files = fs.readdirSync(schemaDir).filter((name) => name.endsWith(".schema.json"));
  if (files.length === 0) {
    throw new Error(`No *.schema.json files found in ${schemaDir}. Run 'pnpm schema' first.`);
  }

  for (const file of files) {
    const filePath = path.join(schemaDir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`${filePath} does not contain a JSON object at its top level.`);
    }
    const id = `https://github.com/ExaDev/agent-shim/releases/download/${tag}/${file}`;
    const stamped = { ...parsed, $id: id };
    fs.writeFileSync(filePath, `${JSON.stringify(stamped, null, 2)}\n`);
    console.log(`Stamped ${file} -> ${id}`);
  }
}

main();
