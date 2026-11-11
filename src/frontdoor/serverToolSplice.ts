/**
 * Edits of a request body as byte spans: every other byte is the request's own, whatever a re-serialisation would have normalised (a number past 2^53, `1.0`, `1e400`, an escape, the spacing).
 */

/** A span `[start, end)` of the body, in bytes, and the bytes that take its place: none, for a removal. The offsets are those of the one structural walk, which are byte offsets because it looks only at ASCII structure. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement?: Buffer;
}

/** `body` with every edit applied, as the slices of it and the replacements in order (views of `body`, never copies of it): joined, they are the edited body, and streamed as they are they cost no copy of it. The edits are disjoint and in any order. */
export function editedSegments(body: Buffer, edits: readonly TextEdit[]): readonly Buffer[] {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const parts: Buffer[] = [];
  let at = 0;
  for (const edit of ordered) {
    if (edit.start < at) {
      throw new RangeError("two edits of one body overlap");
    }
    parts.push(body.subarray(at, edit.start));
    if (edit.replacement !== undefined) {
      parts.push(edit.replacement);
    }
    at = edit.end;
  }
  parts.push(body.subarray(at));
  return parts;
}
