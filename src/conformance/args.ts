/** An argument a case gives as plain data and a function takes as another type, narrowed to text or refused with what it held. */
export function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected text, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** An argument narrowed to a number, or refused with what it held. */
export function numeric(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The environment a case gives: an object of text values. */
export function environment(value: unknown): NodeJS.ProcessEnv {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`expected an environment, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, text(entry)]));
}

/** The optional argument that says where a name came from. */
export function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

