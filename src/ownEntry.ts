/**
 * The value `record` holds under its own key `key`, or undefined when it holds none. A plain object inherits `constructor`, `toString`, `__proto__` and the rest from `Object.prototype`, so `record[key]` answers a name a person or a client chose (a model, a pool, a session id) with a function for those names; every lookup by such a name goes through this.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
