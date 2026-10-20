import { formatTokens } from "../../style";
import { totalTokens } from "../../transcript/tokens";
import type { RenderContext, RowOutput } from "../context";

/** The tokens the whole session has used, summed over every response in its transcript, with the input, output and cache shares beside the total. A session with no transcript to read, or none of whose responses used tokens, draws nothing. While the reader is still catching up with a transcript too big to read at once, the total is short of the truth and ends in a plus. */
export function tokensRow({ palette, transcript }: RenderContext): RowOutput {
  const facts = transcript();
  const total = facts === undefined ? 0 : totalTokens(facts.tokens);
  if (facts === undefined || total === 0) {
    return { kind: "text", lines: [] };
  }
  const { tokens } = facts;
  const parts = [`in: ${formatTokens(tokens.inputTokens)}`, `out: ${formatTokens(tokens.outputTokens)}`];
  const cached = tokens.cacheCreationTokens + tokens.cacheReadTokens;
  if (cached > 0) {
    parts.push(`cache: ${formatTokens(cached)}`);
  }
  return { kind: "text", lines: [palette.paint("label", `Tokens ${formatTokens(total)}${facts.complete ? "" : "+"} (${parts.join(", ")})`)] };
}
