/** RFC 1035 section 2.3.4 fixes a label at 63 octets and a name at 255 octets in wire form, which is 253 characters in dotted text. The limits are written here as literals, not read from the implementation, so changing the implementation's constants turns these tests red. */
export const RFC_1035_MAX_LABEL = 63;
export const RFC_1035_MAX_NAME = 253;

/** A host no refusal reason has a reason to contain; a client's bytes in a reason would be a header injection and a credential leak (userinfo is the authority's secret half). */
export const MARKER = "zq9marker7";

/** Malformed authorities, each carrying the marker where the client's bytes would be echoed. */
export const MALFORMED_WITH_MARKER: readonly string[] = [
  `${MARKER}@host:443`,
  `${MARKER}:secret@host:443`,
  `user:${MARKER}@host:443`,
  `${MARKER} x:443`,
  `${MARKER}/path:443`,
  `${MARKER}?q:443`,
  `[${MARKER}`,
  `[${MARKER}]:443`,
  `[::1]${MARKER}`,
  `[::1]:${MARKER}`,
  `${MARKER}:${MARKER}`,
  `${MARKER}:0`,
  `${MARKER}:65536`,
  `${MARKER}:`,
  `${MARKER}:1:2`,
  `${MARKER}%20x`,
  `${MARKER}\0`,
  `${MARKER}..x`,
  `${MARKER}-.x`,
  `${MARKER}*`,
  `${MARKER}.0x7f.1`,
  `${"a".repeat(RFC_1035_MAX_LABEL + 1)}${MARKER}`,
  `${MARKER}.${"a".repeat(RFC_1035_MAX_NAME)}`,
  `${MARKER}\u200d`,
  `ho]${MARKER}`,
  `ho[${MARKER}`,
];
