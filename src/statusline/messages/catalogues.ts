import { EN } from "./en";
import type { StatuslineLanguage } from "./languages";
import { ZH_HANS } from "./zhHans";
import { ZH_HANT } from "./zhHant";

/** The id of a message in the catalogue. */
export type MessageId = keyof typeof EN;

/** A catalogue: a text for every id, so a language that lacks one does not compile. */
export type Messages = Readonly<Record<MessageId, string>>;

/** The names of the `{name}` placeholders in a message, read from its English text. */
type PlaceholderNames<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}` ? Name | PlaceholderNames<Rest> : never;

/** The values a message needs: none for a message without placeholders, else a value for each name. */
type MessageArguments<Id extends MessageId> = [PlaceholderNames<(typeof EN)[Id]>] extends [never] ? [] : [values: Readonly<Record<PlaceholderNames<(typeof EN)[Id]>, string | number>>];

/** Writes a message in the translator's language, with the values for its placeholders, which the types require. */
export type Translate = <Id extends MessageId>(id: Id, ...values: MessageArguments<Id>) => string;

/** The catalogue of each language. */
export const CATALOGUES: Readonly<Record<StatuslineLanguage, Messages>> = { en: EN, "zh-Hans": ZH_HANS, "zh-Hant": ZH_HANT };

const PLACEHOLDER = /\{(\w+)\}/g;

/** `pattern` with each `{name}` replaced by its value. A placeholder with no value is a defect in the caller or the catalogue, and fails loudly rather than drawing a gap. */
export function fillPlaceholders(pattern: string, values: Readonly<Record<string, string | number>>): string {
  return pattern.replace(PLACEHOLDER, (_placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new TypeError(`message "${pattern}" needs a value for {${name}}`);
    }
    return String(value);
  });
}

/** A translator that writes messages in `language`. */
export function translatorFor(language: StatuslineLanguage): Translate {
  const messages = CATALOGUES[language];
  return (id, ...values) => fillPlaceholders(messages[id], values[0] ?? {});
}
