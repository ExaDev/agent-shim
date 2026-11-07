import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createTranscriptFollower, realTranscriptReadPort, type TranscriptReadPort } from "./transcriptFollower";

function goalRow(attachment: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...attachment } })}\n`;
}

function bridgeRow(bridgeSessionId: string): string {
  return `${JSON.stringify({ type: "bridge-session", sessionId: "local", bridgeSessionId, lastSequenceNum: 1 })}\n`;
}

/** The real read port with every range it reads recorded, so a case can check that only the appended bytes were read. */
function recordingPort(): { readonly port: TranscriptReadPort; readonly ranges: [number, number][] } {
  const ranges: [number, number][] = [];
  return {
    ranges,
    port: {
      sizeOf: realTranscriptReadPort.sizeOf,
      readRange: async (file, start, end) => {
        ranges.push([start, end]);
        return await realTranscriptReadPort.readRange(file, start, end);
      },
    },
  };
}

describe("following a supervised session's transcript", () => {
  it("reads only the bytes appended since its last read, and nothing when the file has not grown", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-shim-follow-"));
    try {
      const file = path.join(dir, "t.jsonl");
      const first = bridgeRow("cse_a") + goalRow({ met: false, sentinel: true, condition: "tests pass" });
      writeFileSync(file, first);
      const { port, ranges } = recordingPort();
      const follower = createTranscriptFollower(port);
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: "cse_a", goal: { condition: "tests pass", iterations: 0 } });
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: "cse_a", goal: { condition: "tests pass", iterations: 0 } });
      appendFileSync(file, goalRow({ met: false, condition: "tests pass", reason: "two fail" }) + bridgeRow("cse_b"));
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: "cse_b", goal: { condition: "tests pass", iterations: 1, lastCheck: "two fail" } });
      const firstLength = Buffer.byteLength(first);
      expect(ranges[0]).toEqual([0, firstLength]);
      expect(ranges).toHaveLength(2);
      expect(ranges[1]?.[0]).toBe(firstLength);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds a line still being written, multi-byte characters included, until its line break arrives", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-shim-follow-"));
    try {
      const file = path.join(dir, "t.jsonl");
      const row = goalRow({ met: false, sentinel: true, condition: "the café opens" });
      const bytes = Buffer.from(row, "utf8");
      // Cut inside the two-byte "é", so a decoder that read each chunk on its own would mangle it.
      const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
      writeFileSync(file, bytes.subarray(0, cut));
      const follower = createTranscriptFollower(realTranscriptReadPort);
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: undefined, goal: null });
      appendFileSync(file, bytes.subarray(cut));
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: undefined, goal: { condition: "the café opens", iterations: 0 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the whole file again when it shrank, and forgets one that is gone", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-shim-follow-"));
    try {
      const file = path.join(dir, "t.jsonl");
      writeFileSync(file, bridgeRow("cse_long_old_identifier") + goalRow({ met: false, sentinel: true, condition: "old" }));
      const follower = createTranscriptFollower(realTranscriptReadPort);
      expect((await follower.factsOf(file))?.goal?.condition).toBe("old");
      writeFileSync(file, bridgeRow("cse_new"));
      expect(await follower.factsOf(file)).toEqual({ bridgeSessionId: "cse_new", goal: null });
      rmSync(file);
      expect(await follower.factsOf(file)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
