import type { ValidateFunction } from "ajv";

/** What `fileProblems` and `manifestProblems` take: an Ajv validator built by `validatorsFrom`. */
export type Validator = ValidateFunction;

/** A function a `function` case can name, taking the decoded arguments. */
export type CaseFunction = (...args: readonly unknown[]) => unknown;

/** The functions a runner executes cases through, by the name a step's `fn` gives. */
export type CaseTable = Readonly<Record<string, CaseFunction>>;

export const MAX_INTEGER: number;
export function selectFiles(root: string): { readonly selected: readonly string[]; readonly problems: readonly string[] };
export function validatorsFrom(root: string): { readonly caseFile: Validator; readonly manifest: Validator };
export function decodeText(text: string | { readonly codeUnits: readonly number[] }): string;
export function canonical(value: unknown): string;
export function fileProblems(bytes: Uint8Array, validate: Validator): readonly string[];
export function manifestProblems(bytes: Uint8Array, validate: Validator): readonly string[];
export function loadCorpus(root: string, schemas?: string): { readonly files: readonly { readonly file: string; readonly cases: readonly unknown[] }[]; readonly problems: readonly string[] };
export function runCase(entry: unknown, table: CaseTable): void;
export function collect(root: string): {
  readonly cases: readonly { readonly file: string; readonly id: string; readonly from: string; readonly skip: "ts" | "rust" | undefined; readonly run: (table: CaseTable) => void }[];
  readonly executed: ReadonlySet<string>;
  readonly problems: readonly string[];
};
