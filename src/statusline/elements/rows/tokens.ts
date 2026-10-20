import { formatTokens } from "../../style";
import { totalTokens } from "../../transcript/tokens";
import type { RenderContext, RowOutput } from "../context";

/** The tokens the whole session has used, summed over every response in its transcript, with the input, output and cache shares beside the total. A session with no transcript to read, or none of whose responses used tokens, draws nothing. While the reader is still catching up with a transcript too big to read at once, the total is short of the truth and ends in a plus. */
export function tokensRow({ palette, transcript, t }: RenderContext): RowOutput {
  const facts = transcript();
  const total = facts === undefined ? 0 : totalTokens(facts.tokens);
  if (facts === undefined || total === 0) {
    return { kind: "text", lines: [] };
  }
  const { tokens } = facts;
  const parts = [t("tokens.input", { count: formatTokens(tokens.inputTokens) }), t("tokens.output", { count: formatTokens(tokens.outputTokens) })];
  const cached = tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (cached > 0) {
    parts.push(t("tokens.cache", { count: formatTokens(cached) }));
  }
  return { kind: "text", lines: [palette.paint("label", t("tokens.summary", { total: `${formatTokens(total)}${facts.complete ? "" : "+"}`, parts: parts.join(t("list.separator")) }))] };
}
