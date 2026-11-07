const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const FIVE_HOURS = 5;
const SEVEN_DAYS = 7;

/** The lengths of Anthropic's two subscription windows, used when a window reported no reset time of its own, and to tell which of a provider's pulled quota windows stands for each. */
export const FIVE_HOUR_WINDOW_MS = FIVE_HOURS * MS_PER_HOUR;
export const SEVEN_DAY_WINDOW_MS = SEVEN_DAYS * HOURS_PER_DAY * MS_PER_HOUR;
