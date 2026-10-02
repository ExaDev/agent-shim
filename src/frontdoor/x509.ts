import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import net from "node:net";

/**
 * X.509 certificate issuance for the front door's local CA and its leaf certificates. The cryptography (key generation, the signature, key and certificate parsing) is all `node:crypto`; this module only assembles the DER bytes of a TBSCertificate (RFC 5280, section 4.1) from the handful of fields claude-use needs. Whether the result is well formed is decided by Node's own certificate parser and TLS stack, which is what the tests check it against.
 */

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;
/** The version field's explicit context tag, `[0]`. */
const TAG_VERSION = 0xa0;
/** The extensions field's explicit context tag, `[3]`. */
const TAG_EXTENSIONS = 0xa3;
/** A GeneralName's implicit context tags (RFC 5280, section 4.2.1.6): `[2]` dNSName and `[7]` iPAddress. */
const TAG_GENERAL_NAME_DNS = 0x82;
const TAG_GENERAL_NAME_IP = 0x87;
/** The authority key identifier's implicit `[0]` keyIdentifier. */
const TAG_KEY_IDENTIFIER = 0x80;

const OID_COMMON_NAME = "2.5.4.3";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
const OID_KEY_USAGE = "2.5.29.15";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_AUTHORITY_KEY_IDENTIFIER = "2.5.29.35";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

/** X.509 version 3 is encoded as the integer 2. */
const VERSION_3 = 2;
/** Bytes of randomness in a certificate serial number: 128 bits, more than any collision a single machine's CA will ever mint. */
const SERIAL_NUMBER_BYTES = 16;
const RSA_MODULUS_BITS = 2048;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const HIGH_BIT = 0x80;
const BASE_128_PAYLOAD_MASK = 0x7f;
/** The first two arcs of an object identifier share one value, `first * 40 + second` (X.690, section 8.19.4). */
const FIRST_ARC_WEIGHT = 40;
const SHORT_FORM_MAX_LENGTH = 0x7f;
const MS_PER_SECOND = 1000;
/** Certificates dated 2050 or later are GeneralizedTime; before, UTCTime (RFC 5280, section 4.1.2.5). */
const UTC_TIME_LAST_YEAR = 2049;
const YEAR_DIGITS = 4;
const TWO_DIGIT_YEAR_DIGITS = 2;
/** `YYYYMMDDHHMMSS`: the digits of a time before its `Z`. */
const COMPACT_TIME_DIGITS = 14;

/** The key-usage bit positions (RFC 5280, section 4.2.1.3) claude-use sets. */
const KEY_USAGE = { digitalSignature: 0, keyEncipherment: 2, keyCertSign: 5, cRLSign: 6 } as const;
type KeyUsageBit = (typeof KEY_USAGE)[keyof typeof KEY_USAGE];

/** One element of DER: a tag, its definite length, its content. */
function tlv(tag: number, content: Uint8Array): Buffer {
  const length = content.length;
  if (length <= SHORT_FORM_MAX_LENGTH) {
    return Buffer.concat([Buffer.from([tag, length]), content]);
  }
  const lengthBytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / (BYTE_MASK + 1))) {
    lengthBytes.unshift(remaining & BYTE_MASK);
  }
  return Buffer.concat([Buffer.from([tag, HIGH_BIT | lengthBytes.length, ...lengthBytes]), content]);
}

function sequence(...parts: readonly Uint8Array[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat(parts));
}

/** A non-negative INTEGER from big-endian magnitude bytes: leading zeros stripped, and one zero byte put back when the high bit would read as a sign. */
function unsignedInteger(magnitude: Uint8Array): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) {
    start += 1;
  }
  const trimmed = magnitude.subarray(start);
  const first = trimmed[0];
  const padded = first !== undefined && (first & HIGH_BIT) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed);
  return tlv(TAG_INTEGER, padded);
}

function smallInteger(value: number): Buffer {
  return unsignedInteger(Buffer.from([value]));
}

/** An OBJECT IDENTIFIER from its dotted form: the first two arcs share one byte, every arc is base-128 with continuation bits. */
function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined || arcs.some((arc) => !Number.isInteger(arc) || arc < 0)) {
    throw new Error(`invalid object identifier ${dotted}`);
  }
  const encoded: number[] = [];
  for (const arc of [first * FIRST_ARC_WEIGHT + second, ...rest]) {
    const groups = [arc & BASE_128_PAYLOAD_MASK];
    for (let remaining = Math.floor(arc / HIGH_BIT); remaining > 0; remaining = Math.floor(remaining / HIGH_BIT)) {
      groups.unshift((remaining & BASE_128_PAYLOAD_MASK) | HIGH_BIT);
    }
    encoded.push(...groups);
  }
  return tlv(TAG_OID, Buffer.from(encoded));
}

function boolean(value: boolean): Buffer {
  return tlv(TAG_BOOLEAN, Buffer.from([value ? BYTE_MASK : 0]));
}

function octetString(content: Uint8Array): Buffer {
  return tlv(TAG_OCTET_STRING, content);
}

/** A BIT STRING holding whole bytes (no unused bits). */
function wholeBitString(content: Uint8Array): Buffer {
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([0]), content]));
}

/** The time in the form RFC 5280 requires for its year. */
function time(instant: Readonly<Date>): Buffer {
  const iso = new Date(Math.floor(instant.getTime() / MS_PER_SECOND) * MS_PER_SECOND).toISOString();
  const compact = `${iso.replace(/[-:T]/g, "").slice(0, COMPACT_TIME_DIGITS)}Z`;
  if (instant.getUTCFullYear() > UTC_TIME_LAST_YEAR) {
    return tlv(TAG_GENERALIZED_TIME, Buffer.from(compact, "ascii"));
  }
  return tlv(TAG_UTC_TIME, Buffer.from(compact.slice(YEAR_DIGITS - TWO_DIGIT_YEAR_DIGITS), "ascii"));
}

/** A distinguished name made of one commonName. */
function commonNameOnly(commonName: string): Buffer {
  return sequence(tlv(TAG_SET, sequence(oid(OID_COMMON_NAME), tlv(TAG_UTF8_STRING, Buffer.from(commonName, "utf8")))));
}

const SIGNATURE_ALGORITHM = sequence(oid(OID_SHA256_WITH_RSA), tlv(TAG_NULL, Buffer.alloc(0)));

/** An extension: its OID, whether it is critical (omitted when not, the DER default), and its value wrapped in an OCTET STRING. */
function extension(extensionOid: string, critical: boolean, value: Uint8Array): Buffer {
  return sequence(oid(extensionOid), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** The keyUsage extension: a named-bit-list BIT STRING with trailing zero bits dropped, as DER requires. */
function keyUsageExtension(bits: readonly KeyUsageBit[]): Buffer {
  const highest = Math.max(...bits);
  const byteCount = Math.floor(highest / BITS_PER_BYTE) + 1;
  const bytes = Buffer.alloc(byteCount);
  for (const bit of bits) {
    const index = Math.floor(bit / BITS_PER_BYTE);
    bytes[index] = (bytes[index] ?? 0) | (HIGH_BIT >> bit % BITS_PER_BYTE);
  }
  const unusedBits = BITS_PER_BYTE - 1 - (highest % BITS_PER_BYTE);
  return extension(OID_KEY_USAGE, true, tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), bytes])));
}

const IPV6_GROUPS = 8;
const HEX_RADIX = 16;
const BYTES_PER_IPV6_GROUP = 2;

/** An IPv6 address's eight 16-bit groups, with `::` expanded and a trailing dotted IPv4 (as in `::ffff:1.2.3.4`) turned into its two groups. */
function ipv6Groups(address: string): number[] {
  const [head = "", tail] = address.split("::");
  const split = (text: string): string[] => (text === "" ? [] : text.split(":"));
  const expand = (groups: readonly string[]): number[] =>
    groups.flatMap((group) => {
      if (!net.isIPv4(group)) {
        return [Number.parseInt(group, HEX_RADIX)];
      }
      const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
      return [a * (BYTE_MASK + 1) + b, c * (BYTE_MASK + 1) + d];
    });
  const before = expand(split(head));
  const after = tail === undefined ? [] : expand(split(tail));
  const filler = tail === undefined ? [] : Array.from({ length: IPV6_GROUPS - before.length - after.length }, () => 0);
  return [...before, ...filler, ...after];
}

/** An IP address as the 4 or 16 octets an iPAddress GeneralName carries. */
export function ipBytes(address: string): Buffer {
  if (net.isIPv4(address)) {
    return Buffer.from(address.split(".").map(Number));
  }
  if (!net.isIPv6(address)) {
    throw new Error(`${address} is not an IP address`);
  }
  const bytes = Buffer.alloc(IPV6_GROUPS * BYTES_PER_IPV6_GROUP);
  ipv6Groups(address).forEach((group, index) => {
    bytes.writeUInt16BE(group, index * BYTES_PER_IPV6_GROUP);
  });
  return bytes;
}

/** The SHA-1 of the subjectPublicKey bits: RFC 5280's first method for a key identifier (section 4.2.1.2). For RSA those bits are the PKCS#1 RSAPublicKey. */
function keyIdentifier(publicKey: KeyObject): Buffer {
  return createHash("sha1").update(publicKey.export({ type: "pkcs1", format: "der" })).digest();
}

/** A parsed element's position in a buffer. */
interface Element {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function readElement(buffer: Uint8Array, offset: number): Element {
  const tag = buffer[offset];
  const first = buffer[offset + 1];
  if (tag === undefined || first === undefined) {
    throw new Error("truncated DER");
  }
  let length = first;
  let contentStart = offset + 2;
  if ((first & HIGH_BIT) !== 0) {
    const count = first & BASE_128_PAYLOAD_MASK;
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * (BYTE_MASK + 1) + (buffer[offset + 2 + index] ?? 0);
    }
    contentStart = offset + 2 + count;
  }
  return { tag, start: offset, contentStart, end: contentStart + length };
}

/** The DER of a certificate's subject name, copied verbatim so a leaf's issuer matches its CA's subject byte for byte (name matching during chain building compares encodings). */
function subjectNameOf(certificateDer: Uint8Array): Buffer {
  const certificate = readElement(certificateDer, 0);
  let cursor = readElement(certificateDer, certificate.contentStart);
  const tbsEnd = cursor.end;
  cursor = readElement(certificateDer, cursor.contentStart);
  if (cursor.tag === TAG_VERSION) {
    cursor = readElement(certificateDer, cursor.end);
  }
  const fieldsBeforeSubject = 4;
  for (let skipped = 1; skipped < fieldsBeforeSubject; skipped += 1) {
    cursor = readElement(certificateDer, cursor.end);
  }
  const subject = readElement(certificateDer, cursor.end);
  if (subject.end > tbsEnd) {
    throw new Error("certificate has no subject");
  }
  return Buffer.from(certificateDer.subarray(subject.start, subject.end));
}

/** A key pair in the PEM forms claude-use persists. */
export interface PemKeyPair {
  readonly certPem: string;
  readonly keyPem: string;
}

function toPem(label: string, der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${body.join("\n")}\n-----END ${label}-----\n`;
}

/** A positive serial with its top bit clear, so the DER INTEGER stays minimal and non-negative. */
function randomSerial(): Buffer {
  const bytes = randomBytes(SERIAL_NUMBER_BYTES);
  bytes[0] = ((bytes[0] ?? 0) & BASE_128_PAYLOAD_MASK) | (HIGH_BIT >> 1);
  return bytes;
}

/** What differs between the CA and a leaf. */
interface CertificateSpec {
  readonly subjectPublicKey: KeyObject;
  readonly subjectName: Buffer;
  readonly issuerName: Buffer;
  readonly signingKey: KeyObject;
  readonly notBefore: Readonly<Date>;
  readonly notAfter: Readonly<Date>;
  readonly extensions: readonly Buffer[];
}

function assemble(spec: CertificateSpec): Buffer {
  const tbs = sequence(
    tlv(TAG_VERSION, smallInteger(VERSION_3)),
    unsignedInteger(randomSerial()),
    SIGNATURE_ALGORITHM,
    spec.issuerName,
    sequence(time(spec.notBefore), time(spec.notAfter)),
    spec.subjectName,
    spec.subjectPublicKey.export({ type: "spki", format: "der" }),
    tlv(TAG_EXTENSIONS, sequence(...spec.extensions)),
  );
  const signature = sign("sha256", tbs, spec.signingKey);
  return sequence(tbs, SIGNATURE_ALGORITHM, wholeBitString(signature));
}

/** The subjectKeyIdentifier extension for a key. */
function subjectKeyIdentifierExtension(publicKey: KeyObject): Buffer {
  return extension(OID_SUBJECT_KEY_IDENTIFIER, false, octetString(keyIdentifier(publicKey)));
}

function basicConstraintsExtension(isCa: boolean): Buffer {
  return extension(OID_BASIC_CONSTRAINTS, true, sequence(...(isCa ? [boolean(true)] : [])));
}

function rsaKeyPair(): { readonly publicKey: KeyObject; readonly privateKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: RSA_MODULUS_BITS });
}

function keyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

/** Generates a self-signed CA certificate, CA-only by basicConstraints and keyUsage, with a random serial. */
export function issueCaCertificate(commonName: string, notBefore: Readonly<Date>, notAfter: Readonly<Date>): PemKeyPair {
  const { publicKey, privateKey } = rsaKeyPair();
  const name = commonNameOnly(commonName);
  const der = assemble({
    subjectPublicKey: publicKey,
    subjectName: name,
    issuerName: name,
    signingKey: privateKey,
    notBefore,
    notAfter,
    extensions: [basicConstraintsExtension(true), keyUsageExtension([KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign]), subjectKeyIdentifierExtension(publicKey)],
  });
  return { certPem: toPem("CERTIFICATE", der), keyPem: keyPem(privateKey) };
}

/** Issues a server-auth leaf under a CA: its own RSA key, the first name as the common name, every name in the subjectAltName (an IP address as an iPAddress entry, because TLS clients match an IP host only against those). */
export function issueLeafCertificate(ca: PemKeyPair, names: readonly string[], notBefore: Readonly<Date>, notAfter: Readonly<Date>): PemKeyPair {
  const [commonName] = names;
  if (commonName === undefined) {
    throw new Error("a leaf certificate needs at least one name");
  }
  const caCertificate = new X509Certificate(ca.certPem);
  const caPrivateKey = createPrivateKey(ca.keyPem);
  const { publicKey, privateKey } = rsaKeyPair();
  const generalNames = names.map((name) => (net.isIP(name) === 0 ? tlv(TAG_GENERAL_NAME_DNS, Buffer.from(name, "ascii")) : tlv(TAG_GENERAL_NAME_IP, ipBytes(name))));
  const der = assemble({
    subjectPublicKey: publicKey,
    subjectName: commonNameOnly(commonName),
    issuerName: subjectNameOf(caCertificate.raw),
    signingKey: caPrivateKey,
    notBefore,
    notAfter,
    extensions: [
      basicConstraintsExtension(false),
      keyUsageExtension([KEY_USAGE.digitalSignature, KEY_USAGE.keyEncipherment]),
      extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH))),
      extension(OID_SUBJECT_ALT_NAME, false, sequence(...generalNames)),
      subjectKeyIdentifierExtension(publicKey),
      extension(OID_AUTHORITY_KEY_IDENTIFIER, false, sequence(tlv(TAG_KEY_IDENTIFIER, keyIdentifier(caCertificate.publicKey)))),
    ],
  });
  return { certPem: toPem("CERTIFICATE", der), keyPem: keyPem(privateKey) };
}
