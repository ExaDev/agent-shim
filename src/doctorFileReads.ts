import { configFaultOf } from "./config/load";

/** How `doctor` reads the files it audits: a file that cannot be read is its own state, apart from one that does not exist, so it is a finding and never stops the report. */

/** The finding for a file that exists and cannot be read, by the read failure's code. */
export function unreadableMessage(file: string, code: string): string {
  return `${file} cannot be read (${code}): check its permissions, or that a directory has not taken its place.`;
}

/** Whether a file is absent: not there at all, as against there and unreadable. */
export function isAbsent(input: Readonly<{ readonly raw: string | undefined; readonly unreadable?: string }>): boolean {
  return input.raw === undefined && input.unreadable === undefined;
}

/** One file's text for the doctor: its text, nothing when it does not exist, or the code of the read that failed, so one unreadable file is a finding and never stops the report. */
export function readForDoctor(reader: Readonly<{ readonly readFileUtf8: (file: string) => string | undefined }>, file: string): { readonly raw: string | undefined; readonly unreadable?: string } {
  try {
    return { raw: reader.readFileUtf8(file) };
  } catch (error) {
    return { raw: undefined, unreadable: configFaultOf(error) };
  }
}
