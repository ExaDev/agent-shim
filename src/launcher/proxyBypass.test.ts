import { describe, expect, it } from "vitest";

import { UsageError } from "../cliError";
import { checkedProxyBypass, withBypassHosts } from "./proxyBypass";

describe("checkedProxyBypass", () => {
  it("returns the entries lowercased and without duplicates, in order, because the runtime matches names case-sensitively", () => {
    expect(checkedProxyBypass(["B.example.com", "a.example.com", "A.example.com"], "test")).toEqual(["b.example.com", "a.example.com"]);
  });

  it("refuses a malformed entry with the source and the entry in the message", () => {
    expect(() => checkedProxyBypass(["a.example.com", "*"], "launch.proxyBypass")).toThrow(UsageError);
    expect(() => checkedProxyBypass(["*"], "launch.proxyBypass")).toThrow('launch.proxyBypass: "*" would take every host off the door');
  });

  it("refuses an entry that covers a host the door must keep, whether it names it, a parent domain or a wildcard of one", () => {
    for (const entry of ["api.anthropic.com", "API.Anthropic.com", "anthropic.com", ".anthropic.com", "platform.claude.com", ".claude.com"]) {
      expect(() => checkedProxyBypass([entry], "test"), entry).toThrow(/off the door/);
    }
  });

  it("accepts a host that only shares a suffix string with a kept one, and an IP literal", () => {
    expect(checkedProxyBypass(["notanthropic.com", "myclaude.com", "10.0.0.1"], "test")).toEqual(["notanthropic.com", "myclaude.com", "10.0.0.1"]);
  });
});

describe("withBypassHosts", () => {
  it("appends only what is not listed yet, keeping the existing order", () => {
    expect(withBypassHosts("a,b", ["B", "c", "c"])).toBe("a,b,c");
  });

  it("builds a list from nothing", () => {
    expect(withBypassHosts(undefined, ["a", "b"])).toBe("a,b");
    expect(withBypassHosts("", [])).toBe("");
  });

  it("drops empty entries from the existing value", () => {
    expect(withBypassHosts(" a ,, b ", ["c"])).toBe("a,b,c");
  });
});
