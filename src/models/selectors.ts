import { CLAUDE_TIERS, type ClaudeTier } from "../config/schema";
import { FAMILY_PREFIX } from "./families";
import { withoutContextMarker } from "./identity";
import { ANTHROPIC_ROUTE_NAME, SELECTOR_PREFIX } from "./reservedModelNames";

/**
 * The model-name grammar that routes a request by what it names rather than by a model: `auto/[<kind>:]<word>[/<class-or-model>]`. The word names a configuration profile, an identity, a pool, a provider or a model family, and the optional kind prefix says which when the word names more than one; the class is a Claude tier (`opus`, `sonnet`, `haiku`, `fable`) and any other rest is an exact model, which may carry slashes of its own (an aggregator's `vendor/model`). A trailing `[1m]` context marker is no part of a name and is taken off first. Bare `auto` is not this grammar: it is the model that follows a provider's live served model.
 *
 * The expansion turns a selector into one name the door already routes (`<provider>/<model>`, `family:<key>`, `anthropic/<model>`, `acct:<identity>/<model>`, or a ref a router's tier pointer names), against the live state the ports read, so the door and `agent-shim model explain` expand a selector by the same rules.
 */

/** The kinds of thing a selector names, in the order a refusal lists them and the kind prefixes that say which is meant. */
export const SELECTOR_KINDS = ["profile", "identity", "pool", "provider", "family"] as const;
export type SelectorKind = (typeof SELECTOR_KINDS)[number];

/** The exact name of an Anthropic model, as a refusal offers it in place of a class the door cannot resolve. */
const ANTHROPIC_SELECTOR_HINT = `${ANTHROPIC_ROUTE_NAME}/<model>`;

/** How each kind is named in a message. */
const KIND_NOUNS: Readonly<Record<SelectorKind, string>> = { profile: "configuration profile", identity: "identity", pool: "pool", provider: "provider", family: "model family" };

/** The grammar as one line, for refusals. */
const GRAMMAR = `${SELECTOR_PREFIX}<selector>[/<class>]`;

/** What follows the selector: nothing, a Claude tier, or an exact model. */
export type SelectorTarget = { readonly kind: "none" } | { readonly kind: "class"; readonly tier: ClaudeTier } | { readonly kind: "model"; readonly model: string };

/** A parsed selector: the kind its prefix named (absent when it named none), the word, and what follows. */
export interface ParsedSelector {
  readonly kind?: SelectorKind;
  readonly name: string;
  readonly target: SelectorTarget;
}

/** What a selector expanded to: the name the door routes it by, the kind the selector named, and the selector as parsed. */
export interface SelectorExpansion {
  readonly name: string;
  /** The kind the selector named, or `class` for a class alone (`auto/<class>`) on the session's current route. */
  readonly kind: SelectorKind | "class";
  readonly selector: ParsedSelector;
  /** Set when the name is on the Anthropic route of the session's own login (see `RoutedName`). */
  readonly onAnthropic?: true;
}

/** The name a selector routes by. `onAnthropic` marks a name the door placed on the Anthropic route of the session's own login (`anthropic/<model>`): it is served there whatever the providers are called, since a provider file called `anthropic` claims that spelling only for a name the person wrote. */
export interface RoutedName {
  readonly name: string;
  readonly onAnthropic?: true;
}

/** Why a name could not be routed: the request is answered with this text (a 400). */
export interface SelectorRefusal {
  readonly refusal: string;
}

/** The kind prefix of `word` when it names one of `SELECTOR_KINDS` (`pool:subs`), with the name after it; any other colon is part of the name. */
function kindOf(word: string): { readonly kind?: SelectorKind; readonly name: string } {
  const colon = word.indexOf(":");
  const prefix = colon < 0 ? undefined : SELECTOR_KINDS.find((kind) => kind === word.slice(0, colon));
  return prefix === undefined ? { name: word } : { kind: prefix, name: word.slice(colon + 1) };
}

/** The target `rest` names: a Claude tier when it is exactly one (in any case), else the exact model it spells. */
function targetOf(rest: string | undefined): SelectorTarget {
  if (rest === undefined) {
    return { kind: "none" };
  }
  const lower = rest.toLowerCase();
  const tier = CLAUDE_TIERS.find((candidate) => candidate === lower);
  return tier === undefined ? { kind: "model", model: rest } : { kind: "class", tier };
}

/**
 * Parses `model` as the selector grammar: undefined when it is not the grammar (it does not start `auto/` once its context marker is off), a refusal when it starts so but names no selector or ends in an empty target, else the parts. Linear in the name's length: one search for each of two slashes and one for a colon.
 */
export function parseSelectorName(model: string): { readonly selector: ParsedSelector } | SelectorRefusal | undefined {
  const bare = withoutContextMarker(model);
  if (!bare.startsWith(SELECTOR_PREFIX)) {
    return undefined;
  }
  const afterPrefix = bare.slice(SELECTOR_PREFIX.length);
  const slash = afterPrefix.indexOf("/");
  const word = slash < 0 ? afterPrefix : afterPrefix.slice(0, slash);
  const rest = slash < 0 ? undefined : afterPrefix.slice(slash + 1);
  const { kind, name } = kindOf(word);
  if (name === "") {
    return { refusal: `the model name ${JSON.stringify(model)} names no selector: write ${GRAMMAR}, where the selector is a configuration profile, an identity, a pool, a provider or a model family` };
  }
  if (rest === "") {
    return { refusal: `the model name ${JSON.stringify(model)} ends in an empty class: write ${GRAMMAR}, where the class is fable, opus, sonnet or haiku or an exact model, or leave the class off` };
  }
  return { selector: { ...(kind === undefined ? {} : { kind }), name, target: targetOf(rest) } };
}

/** What a lookup of one name in one namespace found: nothing, a usable entry, or an entry that exists and cannot be used (its reason names it). */
export type SelectorLookup<T> = { readonly kind: "absent" } | { readonly kind: "found"; readonly value: T } | { readonly kind: "invalid"; readonly reason: string };

/** The live state a selector is expanded against, read at the moment of the request. */
export interface SelectorPorts {
  /** A configuration profile by name, with the provider its `launch` names (through its `extends` chain), if any. */
  readonly profile: (name: string) => SelectorLookup<{ readonly provider: string | undefined }>;
  /** An identity by name, with the provider its own file declares, if any. */
  readonly identity: (name: string) => SelectorLookup<{ readonly provider: string | undefined }>;
  /** Whether a pool of this name is defined. */
  readonly pool: (name: string) => SelectorLookup<undefined>;
  /** The member a pool's ranking picks right now, or why it picks none: asked only once the selector is known to be that pool, since ranking reads every member's usage. */
  readonly poolPick: (name: string) => { readonly identity: string } | SelectorRefusal;
  /** Whether a provider of this name is defined (exactly, as the providers directory lists it). */
  readonly provider: (name: string) => SelectorLookup<undefined>;
  /** The name a provider serves a target under: its default model for none, its own tier mapping for a class (a router's tier pointer, which is a ref of its own), the model itself for an exact model. */
  readonly providerTarget: (provider: string, target: SelectorTarget) => { readonly name: string } | SelectorRefusal;
  /** Whether a model family of this canonical key is offered. */
  readonly family: (key: string) => boolean;
  /** Whether the identity named `identity` holds the login the session runs on: it is the identity stored under `sessionIdentityId` (a directory id, never a name), or another holding the same account in the same organisation; or why that cannot be told. */
  readonly sameLogin: (identity: string, sessionIdentityId: string) => boolean | SelectorRefusal;
  /** The Claude model id the session last sent for a tier, as its own Claude Code resolved the tier: what a class is sent as on the Anthropic route. Undefined until the session has sent one. */
  readonly claudeNameOf: (tier: ClaudeTier) => string | undefined;
  /** The provider the session's main loop is on now (its launch's own, else the one its route context records), or undefined on the Anthropic route: where a class alone (`auto/<class>`) goes. */
  readonly routeProvider: () => string | undefined;
}

/** One lookup of `name` in `kind`'s namespace. */
function lookUp(ports: Readonly<SelectorPorts>, kind: SelectorKind, name: string): SelectorLookup<unknown> {
  const lookups: Readonly<Record<SelectorKind, (name: string) => SelectorLookup<unknown>>> = {
    profile: ports.profile,
    identity: ports.identity,
    pool: ports.pool,
    provider: ports.provider,
    family: (key) => (ports.family(key) ? { kind: "found", value: undefined } : { kind: "absent" }),
  };
  return lookups[kind](name);
}

/** The text of a selector as written, with one kind prefix and the target the request gave, for a refusal that offers the spelling to use. */
function spelling(kind: SelectorKind, name: string, rest: string | undefined): string {
  return `${SELECTOR_PREFIX}${kind}:${name}${rest === undefined ? "" : `/${rest}`}`;
}

/** The target as the person wrote it, for a spelling. */
function restOf(target: SelectorTarget): string | undefined {
  return target.kind === "none" ? undefined : target.kind === "class" ? target.tier : target.model;
}

/** The kinds `name` is found in (an invalid entry counts, so its reason is what is reported), or the one a prefix named. */
function candidatesFor(ports: Readonly<SelectorPorts>, selector: Readonly<ParsedSelector>): readonly SelectorKind[] {
  return selector.kind === undefined ? SELECTOR_KINDS.filter((kind) => lookUp(ports, kind, selector.name).kind !== "absent") : [selector.kind];
}

/**
 * A target on the Anthropic route of the session's own login: an exact model goes there by name, and a class as the model id the session's own Claude Code last sent for that tier (`/model <class>` sends the same id), which the door has seen on one of the session's requests. A class the session has sent no request for yet is refused, naming `/model <class>`, which resolves it in Claude Code; no table in agent-shim names the current id of a tier.
 */
function onAnthropic(ports: Readonly<SelectorPorts>, target: SelectorTarget, what: string, asked: string, written: string): RoutedName | SelectorRefusal {
  if (target.kind === "model") {
    return { name: `anthropic/${target.model}`, onAnthropic: true };
  }
  if (target.kind === "class") {
    const seen = ports.claudeNameOf(target.tier);
    return seen === undefined
      ? { refusal: `${asked} selects ${what} on the Anthropic route, and this session has sent no ${target.tier} request the door has seen, so it cannot tell which model the class means there: choose it once with /model ${target.tier}${ports.provider(ANTHROPIC_ROUTE_NAME).kind === "absent" ? `, or name the exact model as ${ANTHROPIC_SELECTOR_HINT}` : ""}` }
      : { name: `anthropic/${seen}`, onAnthropic: true };
  }
  return { refusal: `${asked} selects ${what}, which runs on the Anthropic route, where a selector needs a class or an exact model: write ${written}/<class> or ${written}/<model>` };
}

/** An identity selected (by name or by a pool's pick): the provider it declares, the session's own login, or another login, which only a relaunch can serve. */
function expandIdentity(ports: Readonly<SelectorPorts>, identity: string, target: SelectorTarget, session: Readonly<{ readonly identityId?: string }>, asked: string, via: string): RoutedName | SelectorRefusal {
  const found = ports.identity(identity);
  if (found.kind === "invalid") {
    return { refusal: found.reason };
  }
  if (found.kind === "absent") {
    return { refusal: `${asked} ${via}identity "${identity}", which does not exist` };
  }
  if (found.value.provider !== undefined) {
    return ports.providerTarget(found.value.provider, target);
  }
  const same = session.identityId === undefined ? false : ports.sameLogin(identity, session.identityId);
  if (typeof same === "object") {
    return same;
  }
  if (same) {
    return onAnthropic(ports, target, `identity "${identity}", the login this session already runs on`, asked, `${SELECTOR_PREFIX}${identity}`);
  }
  if (target.kind === "none") {
    return { refusal: `${asked} ${via}identity "${identity}", another login, which only a relaunch under it can serve: name the class or model to resume with, as ${SELECTOR_PREFIX}${identity}/<class>` };
  }
  return { name: `acct:${identity}/${target.kind === "class" ? target.tier : target.model}` };
}

/** The refusal for a kind that has no entry of the name. */
function absent(kind: SelectorKind, name: string, asked: string): SelectorRefusal {
  return { refusal: `${asked} names no ${KIND_NOUNS[kind]}: no ${KIND_NOUNS[kind]} is called ${JSON.stringify(name)}` };
}

/** The refusal for a lookup that found nothing usable (the entry's own reason when it exists and is invalid), or undefined when it found a usable entry. */
function unusable(found: SelectorLookup<unknown>, kind: SelectorKind, name: string, asked: string): SelectorRefusal | undefined {
  if (found.kind === "invalid") {
    return { refusal: found.reason };
  }
  return found.kind === "absent" ? absent(kind, name, asked) : undefined;
}

/** Expands one selector whose kind is known. */
function expandKind(ports: Readonly<SelectorPorts>, kind: SelectorKind, selector: Readonly<ParsedSelector>, session: Readonly<{ readonly identityId?: string }>, asked: string): RoutedName | SelectorRefusal {
  const { name, target } = selector;
  if (kind === "profile") {
    const profile = ports.profile(name);
    if (profile.kind === "invalid") {
      return { refusal: profile.reason };
    }
    if (profile.kind === "absent") {
      return absent(kind, name, asked);
    }
    const { provider } = profile.value;
    return provider === undefined ? onAnthropic(ports, target, `the configuration profile "${name}"`, asked, `${SELECTOR_PREFIX}${selector.kind === undefined ? "" : `${selector.kind}:`}${name}`) : ports.providerTarget(provider, target);
  }
  const refused = unusable(lookUp(ports, kind, name), kind, name, asked);
  if (refused !== undefined) {
    return refused;
  }
  if (kind === "provider") {
    return ports.providerTarget(name, target);
  }
  if (kind === "family") {
    return target.kind === "none" ? { name: `${FAMILY_PREFIX}${name}` } : { refusal: `${asked} selects the model family "${name}", which is one model and takes no class or model: write ${SELECTOR_PREFIX}${name}` };
  }
  if (kind === "identity") {
    return expandIdentity(ports, name, target, session, asked, "selects ");
  }
  const pick = ports.poolPick(name);
  return "refusal" in pick ? pick : expandIdentity(ports, pick.identity, target, session, asked, `selects pool "${name}", whose ranking picks `);
}

/**
 * Expands `model` when it is the selector grammar: undefined when it is not, a refusal naming the cause and the next step when it cannot be routed, else the one name the door routes it by. An unprefixed word is looked up in every namespace, and a word found in more than one is refused naming each with the prefixed spelling of each: no kind outranks another, since a provider and a pool of one name are equally likely to be meant and a silent choice could move a session to an account the person did not mean. `session.identityId` is the directory id of the identity the session runs as (what the launcher's identity header carries), which an account selector's name is compared with.
 */
export function expandSelectorName(model: string, ports: Readonly<SelectorPorts>, session: Readonly<{ readonly identityId?: string }>): SelectorExpansion | SelectorRefusal | undefined {
  const parsed = parseSelectorName(model);
  if (parsed === undefined || "refusal" in parsed) {
    return parsed;
  }
  const { selector } = parsed;
  const asked = JSON.stringify(withoutContextMarker(model));
  const candidates = candidatesFor(ports, selector);
  const only = candidates[0];
  // A class alone (`auto/sonnet`) is that class on the route the session is on now, when the word names nothing else.
  const alone = selector.kind === undefined && selector.target.kind === "none" ? CLAUDE_TIERS.find((tier) => tier === selector.name.toLowerCase()) : undefined;
  if (alone !== undefined && only === undefined) {
    const provider = ports.routeProvider();
    const target: SelectorTarget = { kind: "class", tier: alone };
    const routed: RoutedName | SelectorRefusal = provider === undefined ? onAnthropic(ports, target, `the ${alone} class of the session's route`, asked, SELECTOR_PREFIX.slice(0, -1)) : ports.providerTarget(provider, target);
    return "refusal" in routed ? routed : { name: routed.name, kind: "class", selector, ...(routed.onAnthropic === true ? { onAnthropic: true } : {}) };
  }
  if (only === undefined) {
    return { refusal: `${asked} names nothing: no configuration profile, identity, pool, provider or model family is called ${JSON.stringify(selector.name)}` };
  }
  if (candidates.length > 1) {
    const named = candidates.map((kind) => `a ${KIND_NOUNS[kind]}`).join(", ");
    const spellings = candidates.map((kind) => spelling(kind, selector.name, restOf(selector.target))).join(", ");
    return { refusal: `${JSON.stringify(selector.name)} is ambiguous: it names ${named}; say which with ${spellings}` };
  }
  if (alone !== undefined) {
    return { refusal: `${JSON.stringify(selector.name)} is ambiguous: it names a ${KIND_NOUNS[only]} and the ${alone} class of the session's route; say which with ${spelling(only, selector.name, undefined)}, or choose the class with /model ${alone}` };
  }
  const expanded = expandKind(ports, only, selector, session, asked);
  return "refusal" in expanded ? expanded : { name: expanded.name, kind: only, selector, ...(expanded.onAnthropic === true ? { onAnthropic: true } : {}) };
}
