/**
 * `value` as JSON text in which every object's keys are in sorted order, so two values holding the same data give the same text however their keys were ordered. Arrays keep their order. `undefined` members are left out as `JSON.stringify` leaves them out.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, member: unknown) => {
    if (typeof member !== "object" || member === null || Array.isArray(member)) {
      return member;
    }
    return Object.fromEntries(Object.entries(member).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}
