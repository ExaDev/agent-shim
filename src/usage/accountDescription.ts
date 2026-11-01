import type { AccountMetadata } from "./schema";

/** The organisation as `account show` and `identity list` word it: its name and its type, whichever are present, joined by a comma; undefined when the stored login has neither. */
export function describeAccountOrganisation(account: Readonly<Pick<AccountMetadata, "organizationName" | "organizationType">>): string | undefined {
  const parts = [account.organizationName, account.organizationType].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** The plan as `identity list` and `identity show` word it: the billing type and the seat tier, whichever are present; undefined when the stored login has neither. */
export function describeAccountPlan(account: Readonly<Pick<AccountMetadata, "billingType" | "seatTier">>): string | undefined {
  const parts = [account.billingType === undefined ? undefined : `billing ${account.billingType}`, account.seatTier === undefined ? undefined : `seat tier ${account.seatTier}`].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}
