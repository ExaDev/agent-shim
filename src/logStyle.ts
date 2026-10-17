import { styleText } from "node:util";

import type { LogPort } from "./launcher/ports";

/** A terminal text format: one of `util.styleText`'s names. */
type TextFormat = "bold" | "dim" | "red" | "yellow";

/** Applies `formats` to `text`, or returns it unchanged when the output it is for takes no colour. */
export type StyleText = (formats: readonly TextFormat[], text: string) => string;

/** The `agent-shim: CODE: ` lead a diagnostic line carries. The code is the part worth picking out. */
const DIAGNOSTIC_LEAD = /^(agent-shim: )([A-Z][A-Z0-9_]*)(: )/;

/** `line` styled as a diagnostic of colour `colour`: the whole line in it, with the code in bold when the line leads with one. */
function styledDiagnostic(style: StyleText, colour: "red" | "yellow", line: string): string {
  const lead = DIAGNOSTIC_LEAD.exec(line);
  if (lead === null) {
    return style([colour], line);
  }
  const [whole, prefix = "", code = "", separator = ""] = lead;
  return `${style([colour], prefix)}${style([colour, "bold"], code)}${style([colour], `${separator}${line.slice(whole.length)}`)}`;
}

/** Where a log port's lines go. */
export interface LogSinks {
  readonly out: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * A `LogPort` that dims information, colours warnings yellow and errors red (each with its diagnostic code in bold), and writes through `sinks`. `styleFor` decides, per output, whether colour applies at all, so a pipe or a `NO_COLOR` environment gets the same plain text as before.
 */
export function createLogPort(sinks: Readonly<LogSinks>, styleFor: { readonly out: StyleText; readonly err: StyleText }): LogPort {
  return {
    info: (message: string) => {
      sinks.out(styleFor.out(["dim"], message));
    },
    warn: (message: string) => {
      sinks.warn(styledDiagnostic(styleFor.err, "yellow", message));
    },
    error: (message: string) => {
      sinks.err(styledDiagnostic(styleFor.err, "red", message));
    },
  };
}

/** `util.styleText` for `stream`, which leaves the text plain unless the stream is a terminal that takes colour and `NO_COLOR` and `FORCE_COLOR` allow it. */
export function styleTextFor(stream: NodeJS.WriteStream): StyleText {
  return (formats, text) => styleText([...formats], text, { stream });
}
