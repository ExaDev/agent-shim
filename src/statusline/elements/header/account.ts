import type { StatuslineSummary } from "../../enrich";
import { graphemesOf } from "../../graphemes";
import type { RenderContext } from "../context";

/** The multiplier of a rate-limit tier: `default_claude_max_20x` carries `20`. */
function tierMultiplierOf(tier: string | undefined): string | undefined {
  const match = /_(\d+)x$/i.exec(tier ?? "");
  return match === null ? undefined : match[1];
}

/** The Max plan's name by its rate-limit multiplier: the 5x plan is sold as Max and the 20x plan as Ultra, while a multiplier with no product name keeps its figure so an unexpected plan stays visible. */
function maxPlanLabel(multiplier: string | undefined): string {
  switch (multiplier) {
    case undefined:
    case "5":
      return "Max";
    case "20":
      return "Ultra";
    default:
      return `Max ${multiplier}x`;
  }
}

/**
 * Maps the OAuth account's plan fields to the label a person knows the plan by, the same mapping the claude-hud fork established from live accounts: the organisation names the plan, a team seat names its tier, and an unmapped organisation type renders raw so an unexpected plan stays visible. An account with no organisation carries its plan only in its rate-limit tier.
 */
function accountPlanLabel(summary: StatuslineSummary): string | undefined {
  switch (summary.loginOrganizationType) {
    case undefined:
      return planLabelOf(summary.loginRateLimitTier);
    case "claude_max": {
      return maxPlanLabel(tierMultiplierOf(summary.loginRateLimitTier));
    }
    case "claude_pro":
      return "Pro";
    case "claude_team":
      if (summary.loginSeatTier === "team_standard") {
        return "Team Standard";
      }
      if (summary.loginSeatTier === "team_tier_1") {
        return "Team Premium";
      }
      return "Team";
    case "claude_enterprise":
      return "Enterprise";
    default:
      return summary.loginOrganizationType;
  }
}

/** Anthropic's rate-limit tier names (`claude_max_20x`, organisation-prefixed `default_claude_pro`, `free`) as the plan name a person knows them by. */
function planLabelOf(tier: string | undefined): string | undefined {
  if (tier === undefined || tier === "") {
    return undefined;
  }
  const cleaned = tier.startsWith("default_") ? tier.slice("default_".length) : tier;
  if (cleaned === "free") {
    return "Free";
  }
  const maxWithMultiplier = /^claude_max_(\d+)x$/.exec(cleaned);
  if (maxWithMultiplier !== null) {
    return maxPlanLabel(maxWithMultiplier[1]);
  }
  if (cleaned === "claude_max") {
    return maxPlanLabel(undefined);
  }
  if (cleaned === "claude_pro") {
    return "Pro";
  }
  return cleaned;
}


/** The account's email address cut to `length` characters with an ellipsis after a cut one; `0` keeps it whole. */
function truncatedUser(email: string, length: number): string {
  const characters = graphemesOf(email);
  return length === 0 || characters.length <= length ? email : `${characters.slice(0, length).join("")}…`;
}

/** The login account the session runs as, with its organisation and plan, or undefined when it adds nothing beside the provider's own account. */
export function accountSegment({ summary, settings }: RenderContext): string | undefined {
  // An account in an organisation is on the organisation's plan with its seat's tier naming the variant, and the seat's rate-limit tier names limits, not the plan; a personal account's plan is the tier itself. A personal plan's organizationName is only the account holder's own name, redundant beside the email, so an organisation's name shows only for the organisation types. Beside a provider the login's plan names quota the session is not drawing from, so there the login names its organisation, or just its account when it has none.
  const loginPlan = summary.provider === undefined ? (summary.loginPlan ?? accountPlanLabel(summary)) : undefined;
  const loginOrgName = summary.loginOrganizationType === "claude_team" || summary.loginOrganizationType === "claude_enterprise" ? summary.loginOrganizationName : undefined;
  const available = {
    user: summary.loginAccountEmail === undefined ? undefined : truncatedUser(summary.loginAccountEmail, settings.account.userLength),
    organisation: loginOrgName,
    plan: loginPlan,
  };
  // Whether the segment names the login at all is decided from what the door knows; the settings then choose which of its parts are written.
  const namesLogin = (summary.loginAccountEmail !== undefined && summary.loginAccountEmail !== summary.providerAccountEmail) || summary.provider === undefined;
  const shown = settings.account.parts.map((part) => available[part]).filter((part) => part !== undefined);
  return namesLogin && shown.length > 0 ? shown.join(" · ") : undefined;
}
