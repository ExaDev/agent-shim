import { describe, expect, it } from "vitest";

import { lineageOf } from "./lineage";

const body = (messages: readonly unknown[], extra: Readonly<Record<string, unknown>> = {}): Buffer => Buffer.from(JSON.stringify({ model: "m", system: "s", messages, ...extra }));
const user = (text: string, marked = false) => ({ role: "user", content: [{ type: "text", text, ...(marked ? { cache_control: { type: "ephemeral" } } : {}) }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("lineageOf", () => {
  it("links a request to the one before it in its thread: its parent key is the previous request's own key", () => {
    const first = lineageOf(body([user("a")]));
    const second = lineageOf(body([user("a"), assistant("b"), user("c")]));
    const third = lineageOf(body([user("a"), assistant("b"), user("c"), assistant("d"), user("e")]));
    expect(second?.parentKey).toBe(first?.ownKey);
    expect(third?.parentKey).toBe(second?.ownKey);
  });

  it("ignores where the cache marker sits, which moves every turn", () => {
    const first = lineageOf(body([user("a", true)]));
    const second = lineageOf(body([user("a"), assistant("b"), user("c", true)]));
    expect(second?.parentKey).toBe(first?.ownKey);
  });

  it("tells a subagent from its parent by the system prompt and tools, and a fork's tail from the parent's", () => {
    const history = [user("a"), assistant("b"), user("c")];
    expect(lineageOf(body(history))?.ownKey).not.toBe(lineageOf(body(history, { system: "another prompt" }))?.ownKey);
    expect(lineageOf(body([...history, assistant("x"), user("fork one")]))?.ownKey).not.toBe(lineageOf(body([...history, assistant("x"), user("fork two")]))?.ownKey);
  });

  it("gives a request with fewer than two earlier messages no parent, and a non-messages body no lineage", () => {
    expect(lineageOf(body([user("a")]))?.parentKey).toBeUndefined();
    expect(lineageOf(Buffer.from("not json"))).toBeUndefined();
    expect(lineageOf(Buffer.from(JSON.stringify({ model: "m" })))).toBeUndefined();
  });
});
