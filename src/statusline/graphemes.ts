const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters of `text` one at a time, read as far as the caller goes, so a cut never splits an emoji or a combined accent in two and a long text costs only what is taken from it. */
export function* graphemeStream(text: string): Generator<string> {
  for (const part of SEGMENTER.segment(text)) {
    yield part.segment;
  }
}

/** The user-perceived characters of `text`, so a cut never splits an emoji or a combined accent in two. */
export function graphemesOf(text: string): string[] {
  return Array.from(graphemeStream(text));
}

/** The first `count` user-perceived characters of `text` (all of them when it has fewer), read no further than that. */
export function leadingGraphemes(text: string, count: number): string[] {
  const taken: string[] = [];
  if (count <= 0) {
    return taken;
  }
  for (const grapheme of graphemeStream(text)) {
    taken.push(grapheme);
    if (taken.length >= count) {
      break;
    }
  }
  return taken;
}
