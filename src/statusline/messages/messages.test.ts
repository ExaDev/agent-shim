import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { CATALOGUES, fillPlaceholders, translatorFor, type MessageId } from "./catalogues";
import { STATUSLINE_LANGUAGES } from "./languages";

const IDS = Object.keys(CATALOGUES.en);
const PLACEHOLDER = /\{(\w+)\}/g;

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "").sort();
}

describe("the message catalogues", () => {
  it("name the languages the setting accepts, English first", () => {
    expect(STATUSLINE_LANGUAGES[0]).toBe("en");
    expect(Object.keys(CATALOGUES).sort()).toEqual([...STATUSLINE_LANGUAGES].sort());
  });

  for (const language of STATUSLINE_LANGUAGES) {
    describe(language, () => {
      const messages: Readonly<Record<string, string>> = CATALOGUES[language];

      it("has a text for every id English has, and no other", () => {
        expect(Object.keys(messages).sort()).toEqual([...IDS].sort());
      });

      it("writes no id as nothing", () => {
        for (const id of IDS) {
          expect(messages[id]?.trim(), id).not.toBe("");
        }
      });

      it("uses exactly the placeholders English uses for each id", () => {
        for (const id of IDS) {
          expect(placeholdersOf(messages[id] ?? ""), id).toEqual(placeholdersOf(CATALOGUES.en[id as MessageId]));
        }
      });
    });
  }

  it("write every language other than English in its own words, not English's", () => {
    for (const language of STATUSLINE_LANGUAGES.filter((name) => name !== "en")) {
      const same = IDS.filter((id) => CATALOGUES[language][id as MessageId] === CATALOGUES.en[id as MessageId]);
      // Product names and abbreviations the languages keep (CC v1, headroom, the CLAUDE.md file) are the only texts allowed to match.
      expect(same.sort(), language).toEqual(["headroom.label", "version.label"]);
    }
  });
});

describe("fillPlaceholders", () => {
  it("replaces each placeholder with its value, as text", () => {
    expect(fillPlaceholders("{a} and {b} and {a}", { a: 1, b: "two" })).toBe("1 and two and 1");
  });

  it("fails when a placeholder has no value, instead of drawing a gap", () => {
    expect(() => fillPlaceholders("{a} {b}", { a: 1 })).toThrow(/needs a value for \{b\}/);
  });
});

describe("translatorFor", () => {
  it("writes a message in its language, with the values the message names", () => {
    expect(translatorFor("en")("cost.today", { amount: "$1.00" })).toBe("Today $1.00");
    expect(translatorFor("zh-Hans")("cost.today", { amount: "$1.00" })).toBe("\u4ECA\u65E5 $1.00");
    expect(translatorFor("zh-Hant")("quota.available")).toBe("\u53EF\u7528");
  });
});

/** The directories and files whose text reaches the screen, as the places a label could be written in place of a message. */
const LABEL_SOURCES = ["elements", "style.ts", "resetTime.ts", "wallClock.ts"];

function sourcesUnder(target: string): string[] {
  const full = path.join(__dirname, "..", target);
  if (fs.statSync(full).isFile()) {
    return [full];
  }
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      return sourcesUnder(child);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path.join(__dirname, "..", child)] : [];
  });
}

/** The text of every string and template piece in the label sources that holds a run of two letters, outside imports, exports and types, by the file it is in. */
function literalsIn(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /[A-Za-z]{2,}/.test(node.text)) {
      const parent = node.parent;
      if (!ts.isImportDeclaration(parent) && !ts.isExportDeclaration(parent) && !ts.isLiteralTypeNode(parent) && !ts.isPropertySignature(parent)) {
        found.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Strings in the label sources that are not words shown to a person, by why. Anything else with letters in it is a label that bypasses the catalogue: write it as a message instead, or add it here with its reason.
 */
const NOT_LABELS: ReadonlySet<string> = new Set([
  // The names of colour roles, element kinds and setting values the code compares or passes on.
  ...["label", "critical", "warning", "gitBranch", "git", "context", "model", "project", "usage", "usageWarning", "empty", "text", "bars", "row", "inline", "started", "remaining", "elapsed", "elapsedAndAbsolute", "absolute", "relative", "both", "full", "short", "symbol", "client", "transcript", "native", "string", "auto", "numeric", "never", "buffered", "shown", "percent", "tokens", "hidden"],
  // The names of the effort levels the client reports, which are matched, and drawn through the catalogue.
  ...["low", "medium", "high", "xhigh", "max"],
  // Names of the products and plans the statusline reports, which no language translates, and the plan identifiers the account sends.
  ...["Max", "Max ", "Pro", "Team", "Team Standard", "Team Premium", "Enterprise", "Free", "claude_max", "claude_pro", "claude_team", "claude_enterprise", "team_standard", "team_tier_1", "default_", "free"],
  // Prefixes and file names of the models and settings the statusline reads, and a locale tag used as a key.
  ...["claude-", "anthropic.", ".claude", "settings.json", "settings.local.json", "en-CA"],
]);

describe("the statusline's words", () => {
  const messageIds = new Set(IDS);
  const literals = LABEL_SOURCES.flatMap((target) => sourcesUnder(target)).flatMap((file) => literalsIn(file).map((text) => ({ text, file: path.basename(file) })));

  it("are written through the catalogue: no element carries a label of its own", () => {
    const bypassing = literals.filter(({ text }) => !messageIds.has(text) && !NOT_LABELS.has(text)).map(({ text, file }) => `${file}: ${JSON.stringify(text)}`);
    expect(bypassing).toEqual([]);
  });

  it("are all used: every message in the catalogue is asked for by some element", () => {
    const used = new Set(literals.map(({ text }) => text));
    expect(IDS.filter((id) => !used.has(id))).toEqual([]);
  });
});
