/**
 * The value `record` holds under its own key `key`, or undefined when it holds none. A plain object inherits `constructor`, `toString`, `__proto__` and the rest from `Object.prototype`, so `record[key]` answers a name a person or a client chose (a model, a pool, a session id, an environment variable, a header) with a function for those names. Every read of a string-keyed record by a plain string under `src` goes through this; `ownEntryGuard.repo.test.ts` holds every module to it by type.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
