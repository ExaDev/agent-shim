import { SHIPPED_CATEGORY_DEFAULTS, isOverridableCategory, type CategoryName } from "../config/schema";
import { evaluateWhen } from "./conditions";
import { matchingRules } from "./flatten";
import type { CompiledRule, Decision, Diagnostic, EliminatedRule, EntryFact, EntryFacts, FlattenedCascade } from "./types";

/** Everything phase two needs, all of it injected. */
export interface DecideParams {
  readonly flattened: FlattenedCascade;
  readonly facts: EntryFacts;
  /** Every top-level `~/.claude` entry name mapped to its category, or to null when nothing recognises it. */
  readonly classification: ReadonlyMap<string, CategoryName | null>;
}

/** A rule chosen by `selectRule`, alongside the candidates eliminated on the way to it. */
export interface RuleSelection {
  readonly rule?: CompiledRule;
  readonly eliminated: readonly EliminatedRule[];
}

/**
 * Picks the winning entries rule for one path.
 *
 * Candidates are ranked by `compareSpecificity` and taken in order. A candidate whose `when` condition **fails is eliminated** and resolution continues to the next-most-specific matching rule — it never falls straight through to the category default, and a failed condition never inverts the rule's boolean value, which would not have a coherent meaning anyway. Only when no candidate survives does the caller fall back to the category.
 */
export function selectRule(
  relPath: string,
  flattened: FlattenedCascade,
  context: {
    nowMs: number;
    branch?: string;
    branchDetached?: boolean;
    env: Readonly<Record<string, string | undefined>>;
    fact?: EntryFact;
  },
): RuleSelection {
  const eliminated: EliminatedRule[] = [];
  for (const rule of matchingRules(flattened, relPath)) {
    const evaluation = evaluateWhen(rule.when, {
      nowMs: context.nowMs,
      ...(context.fact === undefined ? {} : { fact: context.fact }),
      ...(context.branch === undefined ? {} : { branch: context.branch }),
      ...(context.branchDetached === undefined ? {} : { branchDetached: context.branchDetached }),
      env: context.env,
    });
    if (evaluation.passed) {
      return { rule, eliminated };
    }
    eliminated.push({ rule, failed: evaluation.failed });
  }
  return { eliminated };
}

/**
 * Resolves one path to a sharing decision, in exactly this order:
 *
 * 1. **The secret floor.** If the path's top-level entry classifies as `secret`, the answer is `false` unconditionally. This check sits *above* the entries lookup, not merely at the least-specific end of the cascade, and it fires on the path's **real classification**, never on a lexical reading of the key that matched it — so a glob written under a `runtime/` prefix that happens to reach `.credentials.json` is neutralised exactly like a deliberate `secret/` key would be.
 * 2. **Unclassified.** A top-level entry nothing recognises is not shared, and is reported rather than silently guessed at.
 * 3. **Entries rules**, most specific first, with a failing condition eliminating a candidate rather than ending the search.
 * 4. **The category**: a layer's own toggle if any layer set one, otherwise the shipped default.
 */
export function resolveEntry(relPath: string, params: DecideParams): { decision: Decision; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const head = relPath.split("/")[0] ?? relPath;
  const category = params.classification.get(head) ?? null;

  if (category === "secret") {
    for (const rule of matchingRules(params.flattened, relPath)) {
      diagnostics.push({
        code: "SECRET_PATH_NEUTRALISED",
        severity: "warning",
        message:
          `Entry key "${rule.rawKey}" matches "${relPath}", whose real category is secret. Credentials and config ` +
          `backups are never shared with any identity, so this override is ignored for that path.`,
        subject: relPath,
        layer: rule.layer,
      });
    }
    return { decision: { relPath, shared: false, via: "secret-floor", category }, diagnostics };
  }

  if (category === null) {
    diagnostics.push({
      code: "UNCLASSIFIED_ENTRY",
      severity: "warning",
      message:
        `"${head}" is not in the category map, so it is excluded. Run \`agent-shim configure\` to classify it, ` +
        `which records the answer in the local overlay without touching the shipped default map.`,
      subject: head,
    });
    return { decision: { relPath, shared: false, via: "unclassified", category }, diagnostics };
  }

  const fact = params.facts.entries.get(relPath);
  const selection = selectRule(relPath, params.flattened, {
    nowMs: params.facts.nowMs,
    ...(fact === undefined ? {} : { fact }),
    ...(params.facts.branch === undefined ? {} : { branch: params.facts.branch }),
    ...(params.facts.branchDetached === undefined ? {} : { branchDetached: params.facts.branchDetached }),
    env: params.facts.env,
  });

  if (selection.rule !== undefined) {
    const winner = selection.rule;
    if (winner.declaredCategory !== category) {
      diagnostics.push({
        code: "CATEGORY_PREFIX_MISMATCH",
        severity: "warning",
        message:
          `Entry key "${winner.rawKey}" declares the ${winner.declaredCategory} category but matches "${relPath}", ` +
          `which is classified as ${category}.`,
        subject: relPath,
        layer: winner.layer,
      });
    }
    diagnostics.push(...reportOverriddenExactKeys(winner, params, relPath));
    return {
      decision: {
        relPath,
        shared: winner.value,
        via: "entry-rule",
        category,
        rule: winner,
        ...(selection.eliminated.length === 0 ? {} : { eliminated: selection.eliminated }),
      },
      diagnostics,
    };
  }

  if (isOverridableCategory(category)) {
    const override = params.flattened.categories.get(category);
    if (override !== undefined) {
      return {
        decision: {
          relPath,
          shared: override,
          via: "category-override",
          category,
          ...(selection.eliminated.length === 0 ? {} : { eliminated: selection.eliminated }),
        },
        diagnostics,
      };
    }
  }

  return {
    decision: {
      relPath,
      shared: SHIPPED_CATEGORY_DEFAULTS[category],
      via: "category-default",
      category,
      ...(selection.eliminated.length === 0 ? {} : { eliminated: selection.eliminated }),
    },
    diagnostics,
  };
}

/**
 * Reports the one interaction the corrected comparator makes deliberately invisible otherwise: an earlier layer's *exact* key losing to a later layer's *glob*.
 *
 * That outcome is correct — ranking layer above exactness is what stops an untrusted committed `.agent-shim.json` from beating a personal override written later — but it is also the one case where a user's precisely-written key silently stops applying, so it is surfaced rather than resolved in silence.
 */
function reportOverriddenExactKeys(winner: CompiledRule, params: DecideParams, relPath: string): Diagnostic[] {
  if (winner.isExact) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  for (const candidate of params.flattened.rules.values()) {
    if (candidate === winner || !candidate.isExact || candidate.layer >= winner.layer) {
      continue;
    }
    if (!candidate.matches(relPath) || candidate.value === winner.value) {
      continue;
    }
    diagnostics.push({
      code: "EXACT_ENTRY_OVERRIDDEN_BY_LATER_GLOB",
      severity: "info",
      message:
        `For "${relPath}", the exact key "${candidate.rawKey}" from layer ${String(candidate.layer)} is overridden by the ` +
        `glob "${winner.rawKey}" from the later layer ${String(winner.layer)}. A later layer always wins, so a local rule ` +
        `can only ever tighten what an earlier, shared configuration opened.`,
      subject: relPath,
      layer: winner.layer,
    });
  }
  return diagnostics;
}

/** Every decision the resolver reaches, plus every diagnostic raised along the way (phase-one diagnostics included, and de-duplicated). */
export interface ResolveAllResult {
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Resolves every entry in the fact manifest. */
export function resolveAll(params: DecideParams): ResolveAllResult {
  const decisions = new Map<string, Decision>();
  const diagnostics: Diagnostic[] = [...params.flattened.diagnostics];

  for (const relPath of params.facts.entries.keys()) {
    const result = resolveEntry(relPath, params);
    decisions.set(relPath, result.decision);
    diagnostics.push(...result.diagnostics);
  }

  return { decisions, diagnostics: dedupeDiagnostics(diagnostics) };
}

/** Collapses diagnostics that are identical in code, subject, layer, and message — the same unclassified top-level entry otherwise reports once per file beneath it. */
function dedupeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code} ${diagnostic.subject ?? ""} ${diagnostic.layer === undefined ? "" : String(diagnostic.layer)} ${diagnostic.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}
