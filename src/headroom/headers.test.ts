import { describe, expect, it } from "vitest";

import { mergeAnthropicCustomHeaders } from "./headers";

describe("mergeAnthropicCustomHeaders", () => {
  it("serialises additions alone when nothing exists", () => {
    expect(
      mergeAnthropicCustomHeaders([undefined], [{ name: "x-headroom-project-id", value: "/repo" }]),
    ).toBe("x-headroom-project-id: /repo");
  });

  it("appends to existing blocks without disturbing their entries", () => {
    expect(
      mergeAnthropicCustomHeaders(
        ["x-a: 1\nx-b: 2"],
        [{ name: "x-headroom-project-id", value: "/repo" }],
      ),
    ).toBe("x-a: 1\nx-b: 2\nx-headroom-project-id: /repo");
  });

  it("merges several existing blocks and lets an addition replace a same-named entry", () => {
    expect(
      mergeAnthropicCustomHeaders(
        ["x-a: from-parent", "x-b: from-provider"],
        [
          { name: "x-a", value: "overridden" },
          { name: "x-headroom-base-url", value: "https://api.z.ai" },
        ],
      ),
    ).toBe("x-a: overridden\nx-b: from-provider\nx-headroom-base-url: https://api.z.ai");
  });

  it("skips blank lines and keeps values containing colons intact", () => {
    expect(
      mergeAnthropicCustomHeaders(["\nweird-entry\nok: http://x:1"], [{ name: "n", value: "a: b" }]),
    ).toBe("ok: http://x:1\nn: a: b");
  });
});
