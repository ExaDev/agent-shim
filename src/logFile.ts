import fs from "node:fs";

/**
 * Appends `text` to the log file `file`, making `directory` first (a new file gets `mode` when one is given), and drops the text when either fails. A long-lived process logs while it handles a failure, and the log's own append meets the same shortage (EMFILE, ENOSPC): a log write that threw would turn a handled failure into one that ends the request, the timer or the process. A dropped line is not reported anywhere.
 */
export function appendLogText(directory: string, file: string, text: string, mode?: number): void {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(file, text, mode === undefined ? undefined : { mode });
  } catch {
    // The text is lost; the caller's work goes on, and the next line is tried again.
  }
}
