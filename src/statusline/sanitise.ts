import { MAX_DISPLAY_TEXT_CHARS } from "../config/statusline";
import { ESCAPE_SEQUENCE_PATTERN } from "./ansi";
import { BLANK_CELLS_BUT_SPACE, drawsNothing } from "./blank";
import { graphemeStream, graphemesOf, leadingGraphemes } from "./graphemes";

const ESCAPE_SEQUENCES = new RegExp(ESCAPE_SEQUENCE_PATTERN, "g");

/** `text` with its escape sequences removed, each whole: a CSI, an OSC up to its terminator (or to the end of the text or the next escape when it has none) and a lone two-byte escape. */
export function stripEscapeSequences(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "");
}

/** Control characters, and the characters that reorder or isolate bidirectional text and so can make a path read as another. */
const CONTROL_AND_BIDI = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/gu;

/** `text` with the escape sequences, control characters and bidirectional controls removed, so a name read from the machine (a path, a branch, a file) cannot move the cursor, recolour the line or disguise itself in the statusline. */
export function sanitiseDisplayText(text: string): string {
  return stripEscapeSequences(text).replace(CONTROL_AND_BIDI, "");
}

/** `text` made safe as `sanitiseDisplayText` does, trimmed, and cut to `MAX_DISPLAY_TEXT_CHARS` graphemes so a cut never splits one: for a model name, an output style or an advisor read from outside the statusline, which must not crowd the header line. Empty when nothing visible is left. */
export function boundedDisplayText(text: string): string {
  return leadingGraphemes(sanitiseDisplayText(text).trim(), MAX_DISPLAY_TEXT_CHARS).join("").trim();
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

/** The letters that begin a grapheme with whatever follows them, spaces included, and are not format characters (those are removed before this is used): the Prepend characters of the grapheme rules that `Intl.Segmenter` joins to a following space. A space after one of these is part of the grapheme the letter begins. */
const PREPEND_LETTERS = "\\u0D4E\\u{111C2}\\u{111C3}\\u{113D1}\\u{1193F}\\u{11941}\\u{11A84}-\\u{11A89}\\u{11D46}\\u{11F02}";

/**
 * A plain space and the zero-width characters attached to it (nonspacing and enclosing marks, and the joiners), when the space begins its grapheme and nothing that would draw follows the attachments in it. The whole is one grapheme that draws as the space alone, so it can be written as the space. A space after a Prepend letter does not begin its grapheme, which is then drawn whole with the attachments in it, so such a space is left as it is. So is one followed by a character that extends the grapheme past the attachments and draws: a spacing mark, a sara am of Thai or Lao, an emoji modifier or a halfwidth voiced sound mark (which `Grapheme_Extend` and `Emoji_Modifier` cover). The attachments are matched whole (the lookahead and its back reference make the group atomic), so that a shorter match cannot leave one of them to be followed by such a character.
 */
const SPACE_WITH_ATTACHMENTS = new RegExp(`(?<![${PREPEND_LETTERS}]) (?=([\\p{Mn}\\p{Me}\\u200c\\u200d]+))\\1(?![\\p{Mc}\\p{Grapheme_Extend}\\p{Emoji_Modifier}\\u0e33\\u0eb3])`, "gu");

/** `text` with each space written alone (see `SPACE_WITH_ATTACHMENTS`) and each run of spaces cut to `cap`, which is one more than the limit a caller reads to: as many as the first `limit` characters of the result can hold, and one that shows the run goes on. A cap of one more is needed, not only enough: with a limit of none a cap of none would remove the one space between two lone surrogates and let them join. A larger cap would give the same result with more work. A run of spaces is read as one match, where each grapheme of it would be one step of the segmenter. */
function shortenBlankRuns(text: string, cap: number): string {
  return text.replace(SPACE_WITH_ATTACHMENTS, " ").replace(/ +/gu, (run) => (run.length > cap ? " ".repeat(cap) : run));
}

/**
 * `text` as a person would see it: `sanitiseDisplayText`, then invisible format characters and separators removed (a space of any width becomes a plain space, a line separator goes), edge spaces trimmed, and anything left that draws nothing dropped. The result is empty when nothing visible remains, so a name made of zero-width or blank characters can be told from a name. Joiners that hold an emoji sequence or a script's letters together stay, and so do the tag characters of a flag.
 *
 * With `limit`, characters are read one at a time only as far as the result needs: until it holds more than `limit` characters, as a reader of its text segments them, the last of them not a space. The first `limit` characters of the result are then the first `limit` of the unbounded result, because a character can only change how the ones before it are grouped by joining the last of them, and the result may hold one more. Before they are read, each space with the marks and joiners attached to it is written as the space (unless a spacing mark follows, which makes the whole draw), and a run of spaces longer than one more than `limit` is cut to that. Neither changes any character that is kept, or the trim.
 *
 * What the limit bounds is the reading of characters one at a time. The passes over the whole text (linear, in native code, with a small constant) are made either way. So is the reading of a run, inside the text, of characters that each form a grapheme of their own and draw nothing, which costs a step for each however long: lone surrogates, and the default-ignorable characters that no character set assigns. Removing them first could change how the characters around them are grouped, and so which of those draw.
 */
export function visibleDisplayText(text: string, limit = Number.POSITIVE_INFINITY): string {
  const cleaned = sanitiseDisplayText(text)
    .replace(LINE_SEPARATORS, "")
    .replace(BLANK_CELLS_BUT_SPACE, " ")
    .replace(STANDALONE_HANGUL_FILLER, " ")
    .replace(INVISIBLE_FORMAT, (_match, tagSequence: string | undefined) => tagSequence ?? "");
  // A grapheme that takes no column (a lone mark, a selector, a joiner) is dropped, so text of nothing else is empty. A space that such a mark was attached to stays: it is the break between words.
  const kept: string[] = [];
  for (const grapheme of graphemeStream(Number.isFinite(limit) ? shortenBlankRuns(cleaned, limit + 1) : cleaned)) {
    const body = grapheme.replace(/^ /u, "");
    const space = body === grapheme ? "" : " ";
    const drawn = drawsNothing(body) ? space : grapheme;
    if (drawn === "") {
      continue;
    }
    kept.push(drawn);
    // Dropping some of the kept characters only lets others join, so they number the result's characters from above, and the result is counted only once they could pass the limit (the first test only saves counting too early: it may be off by one without changing the result).
    if (drawn.trim() !== "" && kept.length > limit && graphemesOf(kept.join("").trimStart()).length > limit) {
      break;
    }
  }
  return kept.join("").trim();
}

/** A character that is not a separator of words in text from a program. The separators are the white space controls (tab, line feed, vertical tab, form feed, carriage return and the next-line control) and the line and paragraph separators. */
const NOT_SEPARATOR = /[^\t-\r\u0085\u2028\u2029]/gu;

/** A separator of words in text from a program. */
const SEPARATOR = /[\t-\r\u0085\u2028\u2029]/gu;

/** A character that could show something: not a control, a format character, a lone surrogate, a space or separator, a nonspacing or enclosing mark, a default-ignorable character (assigned or not, the Hangul fillers among them), or the braille blank, which draws an empty cell. A spacing mark is left out of the list because it draws. */
const COULD_SHOW = /[^\p{Cf}\p{Cc}\p{Cs}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** A high surrogate that is not the first half of a pair, and a low surrogate that is not the second half of one (the `u` flag makes a pair a single character). They and the patterns after them keep their position between calls, which `joinsSurrogates` sets before it uses them. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]/gu;
/** Sticky, so that it tests the character at `lastIndex` and no other, which is always the start of a character (where a pair would show as its high half), so that the low half of a pair is never taken for a lone one. It needs no `u` flag for that. */
const LONE_LOW_SURROGATE = /[\uDC00-\uDFFF]/gy;

/** A character that cleaning does not remove: not a control or a format character, which are, apart from the two joiners, and not a line or paragraph separator. */
const NOT_REMOVED_BY_CLEANING = new RegExp("[^[\\p{Cc}\\p{Cf}\\u2028\\u2029]--[\\u200c\\u200d]]", "gv");

/**
 * Whether `text` holds a lone high surrogate that only characters cleaning removes separate from a lone low one after it. Those are the only two lone surrogates that can join into a character that draws, and then only by the removal; any other character between them, a space or a mark among them, keeps them apart. The scans are linear: the lone high surrogates are found one after another, and each is followed to the next character that is not removed, which no other high surrogate's scan passes.
 */
function joinsSurrogates(text: string): boolean {
  LONE_HIGH_SURROGATE.lastIndex = 0;
  for (let high = LONE_HIGH_SURROGATE.exec(text); high !== null; high = LONE_HIGH_SURROGATE.exec(text)) {
    NOT_REMOVED_BY_CLEANING.lastIndex = high.index + 1;
    const next = NOT_REMOVED_BY_CLEANING.exec(text);
    if (next === null) {
      return false;
    }
    LONE_LOW_SURROGATE.lastIndex = next.index;
    if (LONE_LOW_SURROGATE.test(text)) {
      return true;
    }
  }
  return false;
}

/** Whether `text` holds a character that could show something, so that cleaning it may leave something; a text that does not always cleans to nothing. A character outside the list of `COULD_SHOW` is one; so is a lone high surrogate followed later by a lone low one, which may join once what lies between them is removed. Lone surrogates otherwise draw nothing, and so a text of them and of what cannot show cleans to nothing. */
export function couldShowSomething(text: string): boolean {
  return COULD_SHOW.test(text) || joinsSurrogates(text);
}

/** The runs of `text` between its separators, one at a time. They are found a character at a time, with no pattern that repeats, so that a single run of any length is read without a deep stack. The two patterns keep their position between calls, which each call sets before it uses them, and no caller reads pieces from two texts at once. */
function* piecesOf(text: string): Generator<string> {
  let from = 0;
  for (;;) {
    NOT_SEPARATOR.lastIndex = from;
    const begins = NOT_SEPARATOR.exec(text);
    if (begins === null) {
      return;
    }
    SEPARATOR.lastIndex = begins.index;
    const ends = SEPARATOR.exec(text);
    if (ends === null) {
      yield text.slice(begins.index);
      return;
    }
    yield text.slice(begins.index, ends.index);
    from = SEPARATOR.lastIndex;
  }
}

/** Cleans one word of a text: the characters of it that a person would see, at least `limit` of them when it has that many. `visibleDisplayText` is the cleaner `visibleWords` uses unless a caller brings its own. */
export type WordCleaner = (word: string, limit: number) => string;

/**
 * `text` as words a person would see: its escape sequences removed first, whole, so a separator inside one cannot split it and leave a tail; then split where white space controls or line and paragraph separators stand, each piece cleaned by `clean`, and the pieces that show something joined by one plain space. Words a program separated with a tab or a line break therefore stay apart however many invisible characters, escape sequences or spaces sit between them, while every other control character is dropped, so its neighbours join. A separator does not end the text: only a caller that wants the first line splits on line breaks first.
 *
 * Pieces are taken one at a time, and no more of them than it takes to pass `limit` characters of result (separators included). A piece in which no character could show something is not handed to the cleaner. The result starts with the first `limit` characters of the unbounded result and may hold more, as `visibleDisplayText` describes.
 *
 * What grows with the length of the text is the passes over the whole of it and the scan of each piece up to the one that brings the result to the limit, which are native and cost little for each character. What the limit bounds is the cleaning of pieces and the reading of characters one at a time, apart from a run, inside one piece, of the characters that `visibleDisplayText` names as read one by one. Counting what the joined words hold segments each new word once more, with the last character before it, so the count costs in proportion to the words taken. A piece of nothing but characters that draw nothing is skipped, and so is one of lone surrogates that no high one precedes a low one in, because only the removal of what lies between a high and a low surrogate can join them into a character that draws.
 */
export function visibleWords(text: string, limit = Number.POSITIVE_INFINITY, clean: WordCleaner = visibleDisplayText): string {
  const words: string[] = [];
  // The characters of the words joined so far, counted as a reader of the joined text segments them: a word that begins with a spacing mark joins the space before it into one character, and a mark that comes before a base joins the space after it, so the words' own counts and the spaces do not add up to it.
  let used = 0;
  // The last character of the joined text, as it is segmented. Appending a space and a word can change only that one and what follows it, so the count is carried on by segmenting just this and the new word.
  let last = "";
  for (const piece of piecesOf(stripEscapeSequences(text))) {
    // One more than the limit is needed, not the limit: the next word is joined with a space, which the last character of the words so far can take in (a Prepend letter does), and a spacing mark can then take in too.
    if (used > limit) {
      break;
    }
    if (!couldShowSomething(piece)) {
      continue;
    }
    // The word is asked for one more character than is still wanted, which is more than it adds to the joined text whenever it joins the space before it, so it always brings the joined text past the limit unless it is the whole of the piece. The one more is needed as well: a word asked for only what is left can stop before characters that, once what draws nothing between them is dropped, merge into a grapheme of the joined text (two regional indicators round a lone surrogate, a run of marks after the space a Prepend letter takes in), and the result would then fall short of the first characters of the unbounded one. The cleaner counts what it has kept by re-segmenting it, and a run that keeps merging keeps that count from passing the ask, so an ask of at least one reads on to the end of such a run.
    const word = clean(piece, limit - used + 1);
    if (word !== "") {
      // Without a limit nothing is counted, so that a text of many words is not segmented for nothing.
      if (Number.isFinite(limit)) {
        const joinedEnd = graphemesOf(`${last}${words.length > 0 ? " " : ""}${word}`);
        used += joinedEnd.length - (words.length > 0 ? 1 : 0);
        last = joinedEnd[joinedEnd.length - 1] ?? "";
      }
      words.push(word);
    }
  }
  return words.join(" ");
}

/** What an extra command printed as the line it is drawn as: `visibleWords`, read as far as `MAX_DISPLAY_TEXT_CHARS` needs, then cut to that many characters as other display text from outside the statusline is. `clean` is `visibleWords`'s cleaner. */
export function boundedVisibleWords(text: string, clean: WordCleaner = visibleDisplayText): string {
  return boundedDisplayText(visibleWords(text, MAX_DISPLAY_TEXT_CHARS, clean));
}
