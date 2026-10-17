/**
 * Model identity: what makes two model names the same model.
 *
 * Providers name the same model differently (`glm-5.1`, `hf:zai-org/GLM-5.1`, `MiniMax-M2.7-highspeed`, `claude-opus-5-5-high`, `claude-opus-5-5[1m]`), and the routing layer needs to know when two targets are the same model so a virtual model can spread or fail over between them. This module is pure: a name goes in, a canonical identity comes out, and two identities compare.
 */

/** The bracketed suffixes a name may carry that say nothing about which model it is. The `[1m]` context-window marker is the known one. */
const NON_IDENTITY_BRACKET_RE = /\[[^\]]*\]/g;

/** A date stamp Anthropic family names may carry (`claude-haiku-4-5-20251001`): part of the release name, not the model. */
const DATE_STAMP_RE = /-(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;

/** Trailing tokens that change a model's behaviour without changing which model it is. A size tier (`gpt-5.6-sol`), a speed tier (`-highspeed`), or an effort or thinking level. */
const KNOWN_VARIANTS = new Set(["high", "medium", "low", "thinking", "xhigh", "max", "highspeed", "sol", "terra", "luna", "mini", "flash-lite", "turbo"]);

/** A name's vendor, inferred from the words in it. An empty vendor means the name gives no clue, and only the family and version can match. */
const VENDOR_BY_NAMESPACE: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "anthropic",
  google: "google",
  openai: "openai",
  zai: "zai",
  "z-ai": "zai",
  minimax: "minimax",
  qwen: "qwen",
  deepseek: "deepseek",
  moonshot: "moonshot",
  meta: "meta",
  mistral: "mistral",
});

const VENDOR_BY_TOKEN: Readonly<Record<string, string>> = Object.freeze({
  claude: "anthropic",
  gemini: "google",
  antigravity: "google",
  gpt: "openai",
  glm: "zai",
  minimax: "minimax",
  qwen: "qwen",
  deepseek: "deepseek",
  kimi: "moonshot",
  llama: "meta",
  mistral: "mistral",
  mixtral: "mistral",
});

/** One model name's identity: which model it is, and the variant of it the name asks for. */
export interface ModelIdentity {
  /** The vendor the name's own words name, or "" when none does. */
  readonly vendor: string;
  /** The model's family with every non-identity decoration removed, hyphen-separated (`claude-opus`, `gemini-3.8-flash`, `glm`). */
  readonly family: string;
  /** The version the family name carries (`5.5`, `3.8`), or "" when the name has none. */
  readonly version: string;
  /** The behaviour-changing variant the name asks for (`high`, `sol`), or "" for the family's default. */
  readonly variant: string;
  /** True when the name's own words name one vendor and the namespace it arrived in names another: the identity is real but the filing is suspicious, so a match on the rest is proposed rather than automatic. */
  readonly vendorConflict: boolean;
  /** The family with its version, the part two names must share to be the same model whatever vendor spelling they use. */
  readonly familyAndVersion: string;
}

/** The punctuation and case differences names carry that are not identity: separators become one hyphen. */
function canonicalText(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(NON_IDENTITY_BRACKET_RE, "")
    .replace(/[\s_]+/g, "-")
    // A version glued to its family word (`xing4.0`) is the family and the version run together; splitting the boundary lets the version be read as one.
    .replace(/([a-z])(\d+(?:\.\d+)+)/g, "$1-$2")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Splits the trailing variant tokens off `tokens`, from the end, while each is a known variant. */
function splitVariants(tokens: readonly string[]): { readonly familyTokens: readonly string[]; readonly variants: readonly string[] } {
  const variants: string[] = [];
  let end = tokens.length;
  for (;;) {
    const token = tokens[end - 1];
    if (token === undefined || !KNOWN_VARIANTS.has(token)) {
      return { familyTokens: tokens.slice(0, end), variants };
    }
    variants.unshift(token);
    end -= 1;
  }
}

/** The first version-shaped run in `tokens` (`5-5`, `3-8`, `2-5`), as dotted digits, or "" when the name has none. */
function versionOf(tokens: readonly string[]): string {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === undefined) {
      return "";
    }
    if (/^\d+$/.test(token) && next !== undefined && /^\d+$/.test(next)) {
      return `${token}.${next}`;
    }
    const dotted = /^\d+(?:\.\d+)+$/.exec(token);
    if (dotted !== null) {
      return dotted[0];
    }
  }
  return "";
}

/**
 * A model name's identity. Everything that is not identity is removed: provider and vendor namespaces (everything up to the last `/`), route suffixes after a `:` (`:free`), bracketed markers (`[1m]`), date stamps, case and separator differences. The trailing behaviour-changing variant is split off, because two names of one family asking for different variants are the same model configured differently, not two models.
 */
export function modelIdentity(rawName: string): ModelIdentity {
  const segments = rawName.trim().toLowerCase().split("/");
  const stripped = canonicalText(segments[segments.length - 1] ?? "").split(":")[0] ?? "";
  const withoutDate = stripped.replace(DATE_STAMP_RE, "");
  const tokens = withoutDate.split("-").filter((token) => token !== "");
  const { familyTokens, variants } = splitVariants(tokens);
  const version = versionOf(familyTokens);
  const versionless = familyTokens.filter((token, index) => {
    if (version === "") {
      return true;
    }
    const dotted = /^\d+(?:\.\d+)+$/.test(token);
    const previous = familyTokens[index - 1];
    const next = familyTokens[index + 1];
    const insideVersionRun = dotted || (/^\d+$/.test(token) && ((previous !== undefined && /^\d+$/.test(previous)) || (next !== undefined && /^\d+$/.test(next))));
    return !insideVersionRun;
  });
  const family = versionless.join("-");
  // A vendor the name's own words carry outranks the namespace it arrived in, because a marketplace re-spells the vendor while the family name travels unchanged.
  const tokenVendor = familyTokens.find((token) => Object.keys(VENDOR_BY_TOKEN).some((key) => token === key || token.startsWith(key)));
  const namespace = segments.length >= 2 ? (segments[0] ?? "").split(":").pop() ?? "" : "";
  const namespaceVendor = VENDOR_BY_NAMESPACE[namespace] ?? "";
  const tokenVendorName = tokenVendor === undefined ? "" : VENDOR_BY_TOKEN[Object.keys(VENDOR_BY_TOKEN).find((key) => tokenVendor === key || tokenVendor.startsWith(key)) ?? ""] ?? "";
  return {
    vendor: tokenVendorName === "" ? namespaceVendor : tokenVendorName,
    vendorConflict: tokenVendorName !== "" && namespaceVendor !== "" && tokenVendorName !== namespaceVendor,
    family,
    version,
    variant: variants.join("-"),
    familyAndVersion: version === "" ? family : `${family}-${version.replace(/\./g, "-")}`,
  };
}

/** How two model names stand relative to each other. */
export type ModelRelation = "same" | "similar" | "distinct";

/** Compares two model names' identities. Same is an automatic match; similar (a version or variant apart, or one family another vendor claims) is proposed and never merged without a decision; distinct is neither. */
export function relateModels(left: string, right: string): ModelRelation {
  const a = modelIdentity(left);
  const b = modelIdentity(right);
  if (a.familyAndVersion !== b.familyAndVersion) {
    return sameFamilyOtherVersion(a, b) ? "similar" : "distinct";
  }
  if (a.variant !== b.variant || a.vendorConflict || b.vendorConflict || (a.vendor !== "" && b.vendor !== "" && a.vendor !== b.vendor)) {
    return "similar";
  }
  return "same";
}

/** True when the two identities name one family at different versions, or one family whose vendor only one side spells. */
function sameFamilyOtherVersion(a: Readonly<ModelIdentity>, b: Readonly<ModelIdentity>): boolean {
  if (a.family !== b.family) {
    return false;
  }
  if (a.vendor !== "" && b.vendor !== "" && a.vendor !== b.vendor) {
    return false;
  }
  return true;
}

/** A user's assertion about model identity, overriding what the names alone say: each `same` group is one model under several names, and each `distinct` pair is two models however alike the names look. */
export interface IdentityAssertions {
  readonly same: readonly (readonly string[])[];
  readonly distinct: readonly (readonly [string, string])[];
}

/** Compares two names with the user's assertions applied on top. */
export function relateWithAssertions(left: string, right: string, assertions: Readonly<IdentityAssertions>): ModelRelation {
  for (const [a, b] of assertions.distinct) {
    if ((a === left && b === right) || (a === right && b === left)) {
      return "distinct";
    }
  }
  const leftGroup = assertions.same.find((group) => group.includes(left));
  const rightGroup = assertions.same.find((group) => group.includes(right));
  if (leftGroup !== undefined && leftGroup === rightGroup && left !== right) {
    return "same";
  }
  const heuristic = relateModels(left, right);
  if (heuristic === "same" && ((leftGroup !== undefined && !leftGroup.includes(right)) || (rightGroup !== undefined && !rightGroup.includes(left)))) {
    // The names look alike but the user has pinned at least one of them to another model, so the likeness is a proposal only.
    return "similar";
  }
  return heuristic;
}
