import { describe, expect, it } from "vitest";

import { describeAccountOrganisation, describeAccountPlan } from "./accountDescription";

describe("describeAccountOrganisation", () => {
  it("joins the organisation's name and type", () => {
    expect(describeAccountOrganisation({ organizationName: "Example Org", organizationType: "claude_team" })).toBe("Example Org, claude_team");
  });

  it("names whichever of the two is present", () => {
    expect(describeAccountOrganisation({ organizationName: "Example Org" })).toBe("Example Org");
    expect(describeAccountOrganisation({ organizationType: "claude_max" })).toBe("claude_max");
  });

  it("is undefined when neither is present", () => {
    expect(describeAccountOrganisation({})).toBeUndefined();
  });
});

describe("describeAccountPlan", () => {
  it("names the billing type and the seat tier", () => {
    expect(describeAccountPlan({ billingType: "stripe_subscription", seatTier: "team_standard" })).toBe("billing stripe_subscription, seat tier team_standard");
  });

  it("names only what is present", () => {
    expect(describeAccountPlan({ billingType: "stripe_subscription" })).toBe("billing stripe_subscription");
    expect(describeAccountPlan({ seatTier: "team_standard" })).toBe("seat tier team_standard");
  });

  it("is undefined when neither is present", () => {
    expect(describeAccountPlan({})).toBeUndefined();
  });
});
