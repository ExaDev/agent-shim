/** The languages the statusline's labels are written in, as BCP 47 tags: English, and Chinese in simplified and in traditional characters. The first is the default, and the one every other catalogue is checked against. */
export const STATUSLINE_LANGUAGES = ["en", "zh-Hans", "zh-Hant"] as const;

export type StatuslineLanguage = (typeof STATUSLINE_LANGUAGES)[number];
