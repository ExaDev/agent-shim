import type { RenderContext, RowOutput } from "../context";
import { nameListRow, NO_LINES } from "./activityParts";

/** The skills the session has used, once each in the order first used: `Skills (3): commit, journal, notebook`. Nothing is drawn before a skill has been used, or without a transcript to read; the count ends in a plus while the reader is still catching up with a transcript too big to read at once. */
export function skillsRow(context: RenderContext): RowOutput {
  const facts = context.transcript();
  return facts === undefined ? NO_LINES : nameListRow("skills.label", facts.activity.skills, facts.complete, context);
}
