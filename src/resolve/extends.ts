import type { ConfigProfile } from "../config/schema";
import type { Diagnostic, Layer, LayerId } from "./types";

/** One configuration profile as loaded from disk, with its entries key order captured at load time. */
export interface ProfileSource {
  readonly name: string;
  readonly profile: ConfigProfile;
  readonly entryOrder?: readonly string[];
  /** Where it was loaded from, for diagnostics. Defaults to the profile name. */
  readonly filepath?: string;
}

/** Loads a profile by name. Injected, so nothing in the resolver reads a file. Returns undefined when no profile of that name exists. */
export type ProfileLoader = (name: string) => ProfileSource | undefined;

/** The linearised `extends` chain plus anything that went wrong resolving it. */
export interface LinearisedProfiles {
  /** Profile names, base-first: every profile appears exactly once, after everything it extends. */
  readonly order: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Linearises a profile's `extends` graph into a base-first order.
 *
 * The walker keeps **two separate structures**, and the distinction is load-bearing rather than stylistic:
 *
 * - `stack` is the current depth-first path. A name already on it means the graph genuinely loops back on itself, which is the only real cycle.
 * - `visited` is every name already emitted anywhere in the walk. A name already in it is a diamond — two branches sharing a base — and must simply be skipped, not re-emitted.
 *
 * Collapsing the two into one shared set produces a silent wrong answer in either direction. Using `stack` alone re-emits a shared base a second time in a diamond, so the base's values get re-applied on top of an intermediate profile that deliberately overrode them — the override silently disappears. Using `visited` alone false-flags every legitimate diamond as a cycle. Neither failure crashes; both just resolve to the wrong configuration.
 *
 * Emission is **post-order**: a profile is appended only after everything it extends, so `c extends [a, b]` where both extend `base` linearises to `[base, a, b, c]` — never `[base, a, base, b, c]`.
 */
export function lineariseProfile(rootName: string, load: ProfileLoader): LinearisedProfiles {
  const stack: string[] = [];
  const visited = new Set<string>();
  const order: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const visit = (name: string): void => {
    if (stack.includes(name)) {
      diagnostics.push({
        code: "EXTENDS_CYCLE",
        severity: "error",
        message: `Circular profile extends: ${[...stack, name].join(" -> ")}. The cycle is broken here and "${name}" is not applied twice.`,
        subject: name,
      });
      return;
    }
    if (visited.has(name)) {
      return;
    }

    const source = load(name);
    if (source === undefined) {
      diagnostics.push({
        code: "MISSING_PROFILE",
        severity: "error",
        message: `Configuration profile "${name}" does not exist.`,
        subject: name,
      });
      visited.add(name);
      return;
    }

    stack.push(name);
    for (const dependency of source.profile.extends ?? []) {
      visit(dependency);
    }
    stack.pop();

    visited.add(name);
    order.push(name);
  };

  visit(rootName);
  return { order, diagnostics };
}

/**
 * Turns a profile's `extends` chain into cascade layers, base-first, starting at `startId`.
 *
 * A resolved profile is not a separate mechanism from the outer cascade: its chain flattens through the same ordered-layer sequence everything else uses, so a profile's resolved patch is simply one more run of inputs to the same algorithm.
 */
export function profileLayers(
  rootName: string,
  load: ProfileLoader,
  startId: LayerId,
): { layers: Layer[]; nextId: LayerId; diagnostics: readonly Diagnostic[] } {
  const { order, diagnostics } = lineariseProfile(rootName, load);
  const layers: Layer[] = [];
  let nextId = startId;

  for (const name of order) {
    const source = load(name);
    if (source === undefined) {
      continue;
    }
    layers.push({
      id: nextId,
      kind: "config-profile",
      source: source.filepath ?? name,
      ...(source.profile.categories === undefined ? {} : { categories: source.profile.categories }),
      ...(source.profile.entries === undefined ? {} : { entries: source.profile.entries }),
      ...(source.entryOrder === undefined ? {} : { entryOrder: source.entryOrder }),
      ...(source.profile.launch === undefined ? {} : { launch: source.profile.launch }),
      ...(source.profile.models === undefined ? {} : { models: source.profile.models }),
    });
    nextId += 1;
  }

  return { layers, nextId, diagnostics };
}
