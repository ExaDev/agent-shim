import { z } from "zod";

import type { AccountMetadata } from "./schema";

/**
 * What an account's plan means for picking it: a subscription with a capacity relative to the smallest paid tier, or an account billed by use.
 */
export const PlanClassSchema = z.union([
  z.strictObject({
    kind: z.literal("subscription"),
    /** The plan's size as a multiple of the smallest subscription tier (Max 5x is 5, Max 20x is 20). */
    capacity: z.number().positive(),
    /** False when the tier string named no multiplier and no tier this project knows, so `capacity` is the neutral 1 rather than a reading. */
    recognised: z.boolean(),
    /** The tier string the classification rests on, when the account had one. */
    tier: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("pay-per-use"),
    tier: z.string().optional(),
  }),
]);
export type PlanClass = z.infer<typeof PlanClassSchema>;

/** A trailing multiplier in a rate-limit tier, such as the `20x` of `default_claude_max_20x`. */
const TIER_MULTIPLIER = /(?:^|_)(\d+)x$/;

/** The tier word Anthropic gives an organisation with no subscription allowance: all usage is billed as extra usage. */
const ZERO_TIER = /(?:^|_)zero$/;

/** The tier words of subscriptions that carry no multiplier: the smallest paid tier, capacity 1 by definition. */
const BASE_TIER = /(?:^|_)(?:pro|free)$/;

/**
 * Classifies an account from the rate-limit tier of its stored login (`organizationRateLimitTier`, which decides the organisation's limits, then `userRateLimitTier`), except that a `zero` user tier decides alone: a seat whose own allowance is zero draws on no plan whatever its organisation's tier says (a usage-based Enterprise seat sits in an organisation tier that reads as a subscription). The tier strings are free text on Anthropic's side, so only the shapes seen are read: a trailing `<n>x` is that multiple, a bare `pro` is 1, a `zero` tier is pay-per-use. Anything else is a subscription of unrecognised size, counted as 1 and marked so the ranking can say it guessed.
 */
export function planOf(account: AccountMetadata | undefined): PlanClass {
  const userTier = account?.userRateLimitTier;
  if (userTier !== undefined && ZERO_TIER.test(userTier)) {
    return { kind: "pay-per-use", tier: userTier };
  }
  const tier = account?.organizationRateLimitTier ?? userTier;
  const tierField = tier === undefined ? {} : { tier };
  if (tier === undefined) {
    return { kind: "subscription", capacity: 1, recognised: false };
  }
  if (ZERO_TIER.test(tier)) {
    return { kind: "pay-per-use", ...tierField };
  }
  const multiplier = TIER_MULTIPLIER.exec(tier)?.[1];
  if (multiplier !== undefined) {
    return { kind: "subscription", capacity: Number(multiplier), recognised: true, ...tierField };
  }
  return { kind: "subscription", capacity: 1, recognised: BASE_TIER.test(tier), ...tierField };
}
