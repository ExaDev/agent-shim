import { describe, expect, it } from "vitest";

import { MAX_TRANSCRIPT_SCAN_BYTES, readTranscriptIdentity, TRANSCRIPT_CHUNK_BYTES } from "./identityTranscript";
import { fakeRangeReader, fakeStatuslinePorts, newReadLog, type ReadLog } from "./testing";

const PATH = "/sessions/s1.jsonl";

/** Records before the newest assistant record, each a quarter of a chunk: more than a chunk's worth, so the newest record is not the only thing in the file. */
const RECORDS_PER_CHUNK = 4;
const QUARTER_CHUNK = TRANSCRIPT_CHUNK_BYTES / RECORDS_PER_CHUNK;
const RECORDS_BEFORE = 40;
/** Line sizes in chunks that leave a line spanning several chunk edges, and byte offsets that move the edges across a record's own fields. */
const SEVERAL_CHUNKS = 3;
const ODD_BYTES = 7;
const SEVERAL_CHUNKS_AND_A_BIT = SEVERAL_CHUNKS * TRANSCRIPT_CHUNK_BYTES + ODD_BYTES;
const TWO_CHUNKS = 2 * TRANSCRIPT_CHUNK_BYTES;
const EDGE_SHIFTS = [0, 1, 2];
/** A session's first read is the file's size, then its chunks. */
const SIZE_READ_AND_ONE_CHUNK = 2;
const FEWER_THAN_THE_CHUNKS_OF_THE_LARGE_LINE = SEVERAL_CHUNKS + 1;

function assistant(model: string, advisorModel?: string, padding = ""): string {
  return JSON.stringify({ type: "assistant", message: { model, content: padding }, ...(advisorModel === undefined ? {} : { advisorModel }) });
}

function user(padding = ""): string {
  return JSON.stringify({ type: "user", message: { content: padding } });
}

/** A line of about `bytes` bytes of ASCII, which pads a record out to a chosen size. */
function filler(bytes: number): string {
  return "x".repeat(bytes);
}

function identityIn(lines: readonly string[], log: ReadLog = newReadLog()): ReturnType<typeof readTranscriptIdentity> {
  return readTranscriptIdentity(fakeStatuslinePorts({ readRange: fakeRangeReader({ [PATH]: `${lines.join("\n")}\n` }, log) }), PATH);
}

/** Names made of two-byte characters, so a chunk edge can fall between the bytes of one; and the byte offsets into the first of them, and into the second, that an edge is put at. */
const WIDE_CHARACTERS = 8;
const BYTES_PER_WIDE_CHARACTER = 2;
const WIDE_MODEL = "é".repeat(WIDE_CHARACTERS);
const WIDE_ADVISOR = "è".repeat(WIDE_CHARACTERS);
const INTO_FIRST_CHARACTER = 1;
const MID_CHARACTER_OFFSETS = [INTO_FIRST_CHARACTER, INTO_FIRST_CHARACTER + BYTES_PER_WIDE_CHARACTER];

const NEITHER = { model: undefined, advisor: undefined };

describe("readTranscriptIdentity", () => {
  it("takes the model and the advisor from the newest assistant record", () => {
    expect(identityIn([assistant("claude-opus-4-7", "claude-sonnet-4-6"), user(), assistant("glm-5.3", "claude-opus-4-7"), user()])).toEqual({ model: "glm-5.3", advisor: "claude-opus-4-7" });
  });

  it("reads no advisor from a record that carries none, though an older one did", () => {
    expect(identityIn([assistant("claude-opus-4-7", "claude-sonnet-4-6"), assistant("glm-5.3")])).toEqual({ model: "glm-5.3", advisor: undefined });
  });

  it("skips a record Claude Code wrote itself, and takes the real model before it", () => {
    expect(identityIn([assistant("glm-5.3", "claude-opus-4-7"), assistant("<synthetic>"), user()])).toEqual({ model: "glm-5.3", advisor: "claude-opus-4-7" });
    expect(identityIn([assistant("<synthetic>"), user()])).toEqual(NEITHER);
  });

  it("finds nothing in a transcript with no assistant record, an empty one, or one that does not exist", () => {
    expect(identityIn([user(), user()])).toEqual(NEITHER);
    expect(readTranscriptIdentity(fakeStatuslinePorts({ readRange: fakeRangeReader({ [PATH]: "" }) }), PATH)).toEqual(NEITHER);
    expect(readTranscriptIdentity(fakeStatuslinePorts({ readRange: fakeRangeReader({}) }), PATH)).toEqual(NEITHER);
  });

  it("reads one chunk and the file's size, and no more, when the newest record is near the end of a long transcript", () => {
    const log = newReadLog();
    const older = Array.from({ length: RECORDS_BEFORE }, () => user(filler(QUARTER_CHUNK)));
    expect(identityIn([...older, assistant("glm-5.3"), user("short")], log)).toEqual({ model: "glm-5.3", advisor: undefined });
    expect(log.reads).toHaveLength(SIZE_READ_AND_ONE_CHUNK);
    expect(log.reads[1]?.length).toBe(TRANSCRIPT_CHUNK_BYTES);
  });

  it("finds a record behind a line larger than several chunks", () => {
    const log = newReadLog();
    expect(identityIn([assistant("glm-5.3", "claude-opus-4-7"), user(filler(SEVERAL_CHUNKS_AND_A_BIT))], log)).toEqual({ model: "glm-5.3", advisor: "claude-opus-4-7" });
    expect(log.reads.length).toBeGreaterThan(FEWER_THAN_THE_CHUNKS_OF_THE_LARGE_LINE);
  });

  it("finds a record that is itself larger than several chunks, whichever way its bytes fall across the chunk edges", () => {
    for (const extra of EDGE_SHIFTS) {
      const line = assistant("glm-5.3", "claude-opus-4-7", filler(TWO_CHUNKS + extra));
      expect(identityIn([user(), line, user("tail")]), `extra ${String(extra)}`).toEqual({ model: "glm-5.3", advisor: "claude-opus-4-7" });
    }
  });

  it("joins a multi-byte character cut by a chunk edge before it is read, in the model and in the advisor", () => {
    for (const target of ["model", "advisor"] as const) {
      for (const insideCharacter of MID_CHARACTER_OFFSETS) {
        const record = `{"type":"assistant","message":{"model":"${WIDE_MODEL}"},"advisorModel":"${WIDE_ADVISOR}"}`;
        const marker = new TextEncoder().encode(target === "model" ? WIDE_MODEL : WIDE_ADVISOR);
        const recordBytes = new TextEncoder().encode(record);
        const targetStart = recordBytes.findIndex((_, at) => marker.every((byte, i) => recordBytes[at + i] === byte));
        // The file ends with a user line sized so that the first chunk edge, counted back from the end, falls `insideCharacter` bytes into the target's first character.
        const userBytes = targetStart + insideCharacter + TRANSCRIPT_CHUNK_BYTES - (recordBytes.length + 1) - 1;
        const padding = userBytes - new TextEncoder().encode(user()).length;
        const text = `${record}\n${user(filler(padding))}\n`;
        const bytes = new TextEncoder().encode(text);
        expect(bytes.length - TRANSCRIPT_CHUNK_BYTES, `${target} edge`).toBe(targetStart + insideCharacter);
        expect(readTranscriptIdentity(fakeStatuslinePorts({ readRange: fakeRangeReader({ [PATH]: text }) }), PATH), `${target} ${String(insideCharacter)}`).toEqual({ model: WIDE_MODEL, advisor: WIDE_ADVISOR });
      }
    }
  });

  it("reads the first line of the file, however large it is", () => {
    expect(identityIn([assistant("glm-5.3", undefined, filler(TWO_CHUNKS)), user("tail")])).toEqual({ model: "glm-5.3", advisor: undefined });
  });

  it("skips a record still being written at the end of the file, and takes the one before it", () => {
    const text = `${assistant("glm-5.3")}\n{"type":"assistant","message":{"model":"cut-sho`;
    expect(readTranscriptIdentity(fakeStatuslinePorts({ readRange: fakeRangeReader({ [PATH]: text }) }), PATH)).toEqual({ model: "glm-5.3", advisor: undefined });
  });

  it("gives up on a record further back than the scan limit, reading no more than the limit from the end", () => {
    const log = newReadLog();
    const lines = [assistant("glm-5.3"), user(filler(MAX_TRANSCRIPT_SCAN_BYTES + TRANSCRIPT_CHUNK_BYTES))];
    expect(identityIn(lines, log)).toEqual(NEITHER);
    const requested = log.reads.slice(1).reduce((total, read) => total + read.length, 0);
    expect(requested).toBe(MAX_TRANSCRIPT_SCAN_BYTES);
  });

  it("does not take a model from text inside a user line that merely quotes an assistant record", () => {
    const quoting = user(assistant("quoted-model"));
    expect(identityIn([assistant("glm-5.3"), quoting])).toEqual({ model: "glm-5.3", advisor: undefined });
  });
});
