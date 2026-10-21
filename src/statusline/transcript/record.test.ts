import { describe, expect, it } from "vitest";

import { parseTranscriptRecord, recordTimeMs } from "./record";

const ONE_AND_A_HALF_SECONDS = 1_500;

describe("parseTranscriptRecord", () => {
  it("reads a line that is a JSON object into a record", () => {
    expect(parseTranscriptRecord('{"type":"user","timestamp":"2026-10-20T09:00:00.000Z"}')).toMatchObject({ type: "user", timestamp: "2026-10-20T09:00:00.000Z" });
    expect(parseTranscriptRecord("{}")).toEqual({});
  });

  it("reads a line that is not an object as no record: text that is not JSON, null, an array, a number, a string", () => {
    for (const line of ["", "{not json", "null", "[1,2]", "[]", "12", '"text"', "true"]) {
      expect(parseTranscriptRecord(line), line).toBeUndefined();
    }
  });

  it("keeps the record when a field has the wrong type, with that field left out", () => {
    expect(parseTranscriptRecord('{"type":"user","timestamp":5}')).toMatchObject({ type: "user" });
  });
});

describe("recordTimeMs", () => {
  it("is the record's timestamp as milliseconds since the epoch", () => {
    expect(recordTimeMs({ timestamp: "1970-01-01T00:00:01.500Z" })).toBe(ONE_AND_A_HALF_SECONDS);
  });

  it("is nothing for a record with no timestamp or one that is not a date", () => {
    expect(recordTimeMs({})).toBeUndefined();
    expect(recordTimeMs({ timestamp: "yesterday" })).toBeUndefined();
  });
});
