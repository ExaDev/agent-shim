import { describe, expect, it } from "vitest";

import type { PromptsPort, SelectParams } from "../configure";
import { scriptedPrompts } from "../test-helpers";
import { promptsIdentityPicker } from "./pickerPrompt";

const REQUEST = {
  message: "Which identity should this launch run as?",
  entries: [
    { value: "work", label: "1. work | alex@example.com" },
    { value: "personal", label: "2. personal | sam@example.com" },
  ],
  initial: "personal",
} as const;

describe("promptsIdentityPicker", () => {
  it("answers with the value of the entry the person chose", async () => {
    expect(await promptsIdentityPicker(scriptedPrompts(["work"])).pick(REQUEST)).toEqual({ kind: "picked", value: "work" });
  });

  it("answers cancelled when the person cancels", async () => {
    expect(await promptsIdentityPicker(scriptedPrompts([Symbol("cancel")])).pick(REQUEST)).toEqual({ kind: "cancelled" });
  });

  it("puts the question to a single-select prompt with the entries as options and the initial entry highlighted", async () => {
    const asked: SelectParams<string>[] = [];
    const prompts: PromptsPort = {
      ...scriptedPrompts([]),
      select: async <Value extends string>(params: SelectParams<Value>): Promise<Value | symbol> => {
        asked.push(params);
        const [first] = params.options;
        return Promise.resolve(first?.value ?? Symbol("none"));
      },
    };
    await promptsIdentityPicker(prompts).pick(REQUEST);
    expect(asked).toEqual([{ message: REQUEST.message, options: [{ value: "work", label: "1. work | alex@example.com" }, { value: "personal", label: "2. personal | sam@example.com" }], initialValue: "personal" }]);
  });

  it("leaves the highlighted entry to the prompt library when the request names none", async () => {
    const asked: SelectParams<string>[] = [];
    const prompts: PromptsPort = {
      ...scriptedPrompts([]),
      select: async <Value extends string>(params: SelectParams<Value>): Promise<Value | symbol> => {
        asked.push(params);
        return Promise.resolve(Symbol("cancel"));
      },
    };
    await promptsIdentityPicker(prompts).pick({ message: REQUEST.message, entries: REQUEST.entries });
    expect(asked[0]).not.toHaveProperty("initialValue");
  });
});
