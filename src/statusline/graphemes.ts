const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters of `text`, so a cut never splits an emoji or a combined accent in two. */
export function graphemesOf(text: string): string[] {
  return Array.from(SEGMENTER.segment(text), (part) => part.segment);
}
