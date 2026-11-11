import { TolerantReader, skipUnreadableCatalogue } from "./storedCatalogue";

/** A `TolerantReader` over the filesystem port `fs` that reads a file it cannot read as an absent one. Made here, in a module that names no path, so the modules that write and move the stored state (which name paths) make no read of a file at all. */
export function skippingReader(fs: Readonly<{ readonly readFileUtf8: (file: string) => string | undefined }>): TolerantReader {
  return new TolerantReader((file) => fs.readFileUtf8(file), skipUnreadableCatalogue);
}
