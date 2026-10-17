import { describe, expect, it } from "vitest";

import { describeUnroutedMembers, matchModels, type ProviderModel } from "./models";

const of = (provider: string, model: string): ProviderModel => ({ provider, model });

describe("matchModels", () => {
  it("groups names that are the same model across providers, and names each by its provider", () => {
    const { same } = matchModels([of("z", "glm-5.1"), of("openrouter", "hf:zai-org/GLM-5.1"), of("m", "MiniMax-M3")]);
    expect(same).toEqual([[of("z", "glm-5.1"), of("openrouter", "hf:zai-org/GLM-5.1")]]);
  });

  it("does not group two models of one provider, or two different models", () => {
    const { same } = matchModels([of("z", "glm-5.1"), of("z", "glm-5.3"), of("z", "glm-5.1[1m]")]);
    expect(same).toEqual([]);
  });

  it("lists a version or variant apart as similar, without grouping it", () => {
    const { same, similar } = matchModels([of("z", "glm-5.1"), of("z2", "glm-5.3"), of("m", "minimax-m2.7"), of("m2", "MiniMax-M2.7-highspeed")]);
    expect(same).toEqual([]);
    expect(similar).toEqual([
      [of("z", "glm-5.1"), of("z2", "glm-5.3")],
      [of("m", "minimax-m2.7"), of("m2", "MiniMax-M2.7-highspeed")],
    ]);
  });

  it("leaves different models unlisted", () => {
    const { same, similar } = matchModels([of("z", "glm-5.1"), of("codex", "gpt-5.6-sol")]);
    expect(same).toEqual([]);
    expect(similar).toEqual([]);
  });
});

describe("describeUnroutedMembers", () => {
  it("says an account member is served by relaunching under its identity, and a family is not yet a candidate", () => {
    expect(describeUnroutedMembers(["acct:work/opus", "family:glm-5", "z/glm-5.3"])).toEqual([
      'acct:work/opus is served by relaunching the session under identity "work", so no quota signal ranks it',
      "family:glm-5 is resolved from the live catalogues, which the door does not read yet, so it is not a candidate",
    ]);
  });

  it("says nothing of a member the door chooses by signal", () => {
    expect(describeUnroutedMembers(["z/glm-5.3", "m/MiniMax-M3"])).toEqual([]);
  });
});
