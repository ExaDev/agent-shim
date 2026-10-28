/** The decimals a written percentage is rounded to. */
const WRITTEN_PERCENT_DECIMALS = 1;

/**
 * A percentage as the rows write it: rounded to `WRITTEN_PERCENT_DECIMALS` decimal, and written without the decimal when that leaves a whole number (`37`, `4`, but `37.4`), so a figure the client reports as a whole number reads as one. The rounding is the same whichever way it is written, so `Number()` of the text is the percentage to one decimal.
 */
export function writtenPercent(percent: number): string {
  const rounded = Number(percent.toFixed(WRITTEN_PERCENT_DECIMALS));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(WRITTEN_PERCENT_DECIMALS);
}
