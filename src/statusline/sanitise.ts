import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { ESCAPE_SEQUENCE_PATTERN } from "./ansi";
import { BLANK_CELLS, drawsNothing } from "./blank";
import { graphemesOf } from "./graphemes";

const ESCAPE_SEQUENCES = new RegExp(ESCAPE_SEQUENCE_PATTERN, "g");

/** Control characters, and the characters that reorder or isolate bidirectional text and so can make a path read as another. */
const CONTROL_AND_BIDI = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/gu;

/** `text` with the escape sequences, control characters and bidirectional controls removed, so a name read from the machine (a path, a branch, a file) cannot move the cursor, recolour the line or disguise itself in the statusline. */
export function sanitiseDisplayText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(CONTROL_AND_BIDI, "");
}

/** `text` made safe as `sanitiseDisplayText` does, trimmed, and cut to `MAX_DISPLAY_TEXT_CHARS` graphemes so a cut never splits one: for a model name, an output style or an advisor read from outside the statusline, which must not crowd the header line. Empty when nothing visible is left. */
export function boundedDisplayText(text: string): string {
  return graphemesOf(sanitiseDisplayText(text).trim()).slice(0, MAX_DISPLAY_TEXT_CHARS).join("").trim();
}

/** A flag or region emoji drawn as a tag sequence: a black flag, tag letters spelling the region, and the tag that cancels them. Its tag characters are format characters, but they are what makes the flag a particular one. */
const TAG_SEQUENCE = "\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}";

/** Format characters that draw nothing, other than the joiners that shape the text around them (the zero-width joiner holds an emoji sequence or a conjunct together, the non-joiner keeps Persian and Indic letters apart), and tag characters outside a tag sequence. A tag sequence is matched whole so it is kept. */
const INVISIBLE_FORMAT = new RegExp(`(${TAG_SEQUENCE})|(?![\\u200C\\u200D])\\p{Cf}`, "gu");

/** Line and paragraph separators, which would split the line. */
const LINE_SEPARATORS = /[\u2028\u2029]/gu;

/** The Hangul jamo that make up a syllable, other than the two fillers: modern and archaic jamo, and their extension blocks. */
const HANGUL_JAMO = "\\u1100-\\u115E\\u1161-\\u11FF\\uA960-\\uA97F\\uD7B0-\\uD7FF";

/** The Hangul choseong and jungseong fillers when they stand apart from a jamo cluster, where they are blank cells. Beside a jamo they are part of a decomposed syllable and are left alone. */
const STANDALONE_HANGUL_FILLER = new RegExp(`(?<![${HANGUL_JAMO}])[\\u115F\\u1160](?![${HANGUL_JAMO}])`, "gu");

/**
 * `text` as a person would see it: `sanitiseDisplayText`, then invisible format characters and separators removed (a space of any width becomes a plain space, a line separator goes), edge spaces trimmed, and anything left that draws nothing dropped. The result is empty when nothing visible remains, so a name made of zero-width or blank characters can be told from a name. Joiners that hold an emoji sequence or a script's letters together stay, and so do the tag characters of a flag.
 */
export function visibleDisplayText(text: string): string {
  const cleaned = sanitiseDisplayText(text)
    .replace(LINE_SEPARATORS, "")
    .replace(BLANK_CELLS, " ")
    .replace(STANDALONE_HANGUL_FILLER, " ")
    .replace(INVISIBLE_FORMAT, (_match, tagSequence: string | undefined) => tagSequence ?? "");
  // A grapheme that takes no column (a lone mark, a selector, a joiner) is dropped, so text of nothing else is empty. A space that such a mark was attached to stays: it is the break between words.
  return graphemesOf(cleaned)
    .map((grapheme) => {
      const body = grapheme.replace(/^ /u, "");
      const space = body === grapheme ? "" : " ";
      return drawsNothing(body) ? space : grapheme;
    })
    .join("")
    .trim();
}
