import type { Candidate } from "./pick";

/**
 * How a ranked pool member is described after its name, in `pool pick` and in a launch's explanation of its pick: its class, with its score and the reset the score divides by when it has one, and a note when its five-hour window would run dry.
 */
export function candidateHeading(candidate: Readonly<Pick<Candidate, "class" | "score" | "scoreWindow" | "feasible">>): string {
  const score = candidate.score === undefined ? "" : ` score ${candidate.score.toFixed(2)}${candidate.scoreWindow === "fiveHour" ? " by 5h reset" : " by 7d reset"}`;
  const dry = candidate.feasible ? "" : " (5h would run dry)";
  return `[${candidate.class}${score}]${dry}`;
}
