import { describe, expect, it } from "vitest";
import { errorReason } from "./errorReason";

describe("errorReason", () => {
  it("is the message of an error that has one", () => {
    expect(errorReason(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });

  it("joins the attempts of an aggregate error with an empty message", () => {
    const aggregate = new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")], "");
    expect(errorReason(aggregate)).toBe("connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
  });

  it("falls back to the code, then to a fixed phrase, so it is never empty", () => {
    const coded: NodeJS.ErrnoException = new Error("");
    coded.code = "ECONNRESET";
    expect(errorReason(coded)).toBe("ECONNRESET");
    expect(errorReason(new Error(""))).toBe("the request failed with no reason given");
  });
});
