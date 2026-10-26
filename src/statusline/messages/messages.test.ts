import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { CATALOGUES, fillPlaceholders, translatorFor, type MessageId } from "./catalogues";
import { STATUSLINE_LANGUAGES } from "./languages";

/** Whether `value` is the id of a message. */
function isMessageId(value: string): value is MessageId {
  return Object.hasOwn(CATALOGUES.en, value);
}

const IDS: readonly MessageId[] = Object.keys(CATALOGUES.en).filter(isMessageId);
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
      const messages = CATALOGUES[language];

      it("has a text for every id English has, and no other", () => {
        expect(Object.keys(messages).sort()).toEqual([...IDS].sort());
      });

      it("writes no id as nothing", () => {
        for (const id of IDS) {
          expect(messages[id].trim(), id).not.toBe("");
        }
      });

      it("uses exactly the placeholders English uses for each id", () => {
        for (const id of IDS) {
          expect(placeholdersOf(messages[id]), id).toEqual(placeholdersOf(CATALOGUES.en[id]));
        }
      });
    });
  }

  it("write every language other than English in its own words", () => {
    for (const language of STATUSLINE_LANGUAGES.filter((name) => name !== "en")) {
      const same = IDS.filter((id) => CATALOGUES[language][id] === CATALOGUES.en[id]);
      // The name of the proxy, the abbreviation of the client and the space after a mark are the only texts the languages keep as they are.
      expect(same.sort(), language).toEqual(["headroom.label", "mark.line", "version.label"]);
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

/** Every module under `src/statusline` that is not a test, by its path from there. */
function allModules(directory = ""): string[] {
  const full = path.join(__dirname, "..", directory);
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return allModules(child);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [child] : [];
  });
}

/** The text of every string and template piece in a module that holds a letter, outside imports, exports and types. */
function literalsIn(file: string, withoutLetters = false): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, "..", file), "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && (withoutLetters || /[A-Za-z]/.test(node.text))) {
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

/** The directories whose modules read or hold data and never write text for the screen, each with why. A module in one that started to draw words would have to move out of it. The transcript reader is not one: it reads the client's own wording, and what it keeps for the screen (a missing title, an unnamed agent) is a fact for the elements to write in a language's words, so it is held to the same rule as they are, with the names it compares listed below. */
const DATA_DIRECTORIES: Readonly<Record<string, string>> = {
  messages: "the catalogues themselves",
  parity: "the record of claude-hud's settings, read by tests and documents",
  vcs: "reads git and Jujutsu into a status; the vcs segment draws it, and says a detached head in the catalogue's words",
};

/** The modules outside those directories that write no words for the screen, by why: they carry settings, talk to the machine or the network, or lay out and paint text others wrote. */
const PLUMBING: Readonly<Record<string, readonly string[]>> = {
  "carry the settings and the command line": ["change.ts", "commands.ts", "keys.ts", "settings.ts"],
  "read the machine, the client's payload and the door": ["cacheFile.ts", "client.ts", "configCounts.ts", "dailyLedger.ts", "doorCost.ts", "enrich.ts", "headroom.ts", "identityTranscript.ts", "payload.ts", "ports.ts", "speed.ts"],
  "lay out, measure, paint and clean text that others wrote": ["ansi.ts", "barGrid.ts", "blank.ts", "colour.ts", "graphemes.ts", "headerLayout.ts", "palette.ts", "render.ts", "rowsLayout.ts", "sanitise.ts", "width.ts"],
  "stand in for the machine in tests": ["testing.ts", "transcript/activityTesting.ts"],
};

/**
 * Strings in the modules that write words for the screen that are not words, by module and why. Anything else with a letter in it is a label that bypasses the catalogue: write it as a message instead, or add it here, in the module it is in. A string naming a message is not listed, because it is the catalogue being used.
 */
const NOT_WORDS: Readonly<Record<string, readonly string[]>> = {
  // The names of the sources, settings and colour roles the code compares or passes on.
  "cost.ts": ["native", "estimate"],
  "elements/customLine.ts": ["custom"],
  "elements/header/cost.ts": ["native"],
  "elements/header/effort.ts": ["low", "medium", "high", "xhigh", "max", "string", "text", "symbol"],
  "elements/header/model.ts": ["claude-", "anthropic.", "full", "short", "client", "transcript"],
  "elements/header/project.ts": ["label", "inline"],
  "elements/header/vcs.ts": ["critical", "warning", "gitBranch", "git", "context"],
  "elements/registry.ts": ["model", "label", "project", "git"],
  "elements/rows/activityParts.ts": ["text", "label", "activity", "context"],
  "elements/rows/addedDirs.ts": ["row", "text", "label"],
  "elements/rows/agents.ts": ["running", "completed", "warning", "context", "label", "agent", "text"],
  "elements/rows/compactions.ts": ["text", "label"],
  "elements/rows/context.ts": ["context", "label", "bars", "text", "never", "buffered", "shown", "hidden", "both", "percent", "tokens", "remaining", "critical"],
  "elements/rows/environment.ts": ["text", "label"],
  "elements/rows/gitFiles.ts": ["context", "critical", "warning", "text", "label"],
  "elements/rows/memory.ts": ["usage", "label", "bars"],
  "elements/rows/promptCache.ts": ["text", "label", "warning", "context"],
  "elements/rows/quota.ts": ["remaining", "usage", "label", "text", "bars"],
  "elements/rows/todos.ts": ["completed", "in_progress", "context", "warning", "text", "label"],
  "elements/rows/tokens.ts": ["text", "label"],
  "elements/rows/tools.ts": ["label", "running", "Read", "Write", "Edit", "Skill", "skills", "warning", "activity", "context", "text"],
  "elements/rows/sessionTime.ts": ["started", "label", "text"],
  "projectPath.ts": ["full"],
  "resetTime.ts": ["relative", "absolute", "both", "elapsed", "elapsedAndAbsolute"],
  "style.ts": ["usage", "usageWarning", "warning", "critical", "empty", "use", "width", "M", "k", "s", "d ", "h", "h ", "m"],
  "wallClock.ts": ["en-CA", "medium", "short", "auto", "numeric"],
  // The names the client's transcript is written in (record types, tool names, input fields and statuses), the environment variables it reads and the markers it leaves in a user's text, which the reader compares and never draws; and the results of `typeof` and the digest algorithms.
  "transcript/activity.ts": ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "Task", "Agent", "TodoWrite", "TaskCreate", "TaskUpdate", "Skill", "Bash", "async_launched", "teammate_spawned", "pending", "in_progress", "completed", "string", "Read", "Write", "Edit", "file_path", "path", "Glob", "Grep", "pattern", "skill", "command", "not_started", "running", "complete", "done", "object", "content", "status", "number", "subject", "description", "deleted", "sha256", "base64url", "subagent_type", "model", "true", "queue-operation", "enqueue", "assistant", "tool_result", "tool_use", "user", "error"],
  "transcript/reader.ts": ["transcript", "sha256", "hex"],
  "transcript/record.ts": ["object"],
  "transcript/session.ts": ["<command-name>", "<command-message>", "<local-command-", "[Request interrupted by user", "string", "tool_result", "text", "assistant", "user", "system", "compact_boundary", "custom-title", "ai-title"],
  "transcript/tokens.ts": ["assistant"],
  // Names of the products and plans the statusline reports, which no language translates, the identifiers the account sends, the endpoints and model ids a platform is known by, and the file names it reads.
  "elements/header/account.ts": ["claude_max", "Max", "Max ", "claude_pro", "Pro", "claude_team", "team_standard", "Team Standard", "team_tier_1", "Team Premium", "Team", "claude_enterprise", "Enterprise", "default_", "free", "Free", "x"],
  "elements/header/outputStyle.ts": [".claude", "settings.json", "settings.local.json"],
  "platform.ts": ["Bedrock", "Vertex", "MiniMax", "Enterprise", "https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic", "opusplan", "sonnetplan", "haikuplan", "anthropic.claude-"],
  // The symbols that stand for units, which are the same in every language: durations, token counts and bytes.
  "elements/sessionFormat.ts": ["<1m", "<1s", "m", "m ", "h ", "s", "h", "d"],
  "memoryUse.ts": ["B", "KB", "MB", "GB", "TB"],
};

/** The strings with a comma, colon or semicolon in them that the catalogue does not hold, by module and why: the colon that names the version control in `git:(main)`, which is the syntax of the segment and not a sentence, and the colon in the two MiniMax endpoint URLs the platform check compares a base URL with, which are addresses and not sentences. */
const PUNCTUATION_KEPT: Readonly<Record<string, readonly string[]>> = {
  "elements/header/vcs.ts": [":("],
  "platform.ts": ["https://api.minimax.io/anthropic", "https://api.minimaxi.com/anthropic"],
};

/** The modules that are neither plumbing nor in a data directory, which are the ones that write words: any module that is added falls here until someone decides which it is. */
function writingModules(): string[] {
  const plumbing = new Set(Object.values(PLUMBING).flat());
  return allModules().filter((file) => !Object.hasOwn(DATA_DIRECTORIES, file.split(path.sep)[0] ?? file) && !plumbing.has(file));
}

describe("the statusline's words", () => {
  const messageIds = new Set<string>(IDS);
  const modules = writingModules();

  it("are written through the catalogue: no module that writes for the screen carries a string of its own", () => {
    const bypassing = modules.flatMap((file) =>
      literalsIn(file)
        .filter((text) => !messageIds.has(text) && !(NOT_WORDS[file] ?? []).includes(text))
        .map((text) => `${file}: ${JSON.stringify(text)}`),
    );
    expect(bypassing).toEqual([]);
  });

  it("take their commas, colons and semicolons from the catalogue, because a language writes its own", () => {
    const written = modules.flatMap((file) =>
      literalsIn(file, true)
        .filter((text) => /[,:;\uFF0C\uFF1A\uFF1B\u3001]/.test(text) && !messageIds.has(text) && !(PUNCTUATION_KEPT[file] ?? []).includes(text))
        .map((text) => `${file}: ${JSON.stringify(text)}`),
    );
    expect(written).toEqual([]);
  });

  it("leave no exemption unused: every string listed as kept is in its module", () => {
    const stale = [
      ...Object.entries(NOT_WORDS).flatMap(([file, texts]) => {
        const present = new Set(modules.includes(file) ? literalsIn(file) : []);
        return texts.filter((text) => !present.has(text)).map((text) => `${file}: ${JSON.stringify(text)}`);
      }),
      ...Object.entries(PUNCTUATION_KEPT).flatMap(([file, texts]) => {
        const present = new Set(modules.includes(file) ? literalsIn(file, true) : []);
        return texts.filter((text) => !present.has(text)).map((text) => `${file}: ${JSON.stringify(text)}`);
      }),
    ];
    expect(stale).toEqual([]);
  });

  it("are all used: every message in the catalogue is asked for by some module", () => {
    const used = new Set(modules.flatMap((file) => literalsIn(file)));
    expect(IDS.filter((id) => !used.has(id))).toEqual([]);
  });

  it("name only modules that exist among the data directories and the plumbing", () => {
    const modulesOnDisk = new Set(allModules());
    expect(Object.values(PLUMBING).flat().filter((file) => !modulesOnDisk.has(file))).toEqual([]);
    expect(Object.keys(DATA_DIRECTORIES).filter((directory) => !fs.existsSync(path.join(__dirname, "..", directory)))).toEqual([]);
    expect(Object.keys(NOT_WORDS).filter((file) => !modulesOnDisk.has(file))).toEqual([]);
  });
});
