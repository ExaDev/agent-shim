import { AccountMetadataError, readAccountMetadata } from "./usage/account";
import { describeAccountOrganisation, describeAccountPlan } from "./usage/accountDescription";
import type { FarmFs } from "./launcher/ports";
import type { AccountMetadata } from "./usage/schema";

/** The account fields `identity list` and `identity show` carry: who the login is, the organisation it belongs to, the role it holds there and the plan it is on. Never an identifier or a token. */
export type IdentityAccountSummary = Pick<AccountMetadata, "emailAddress" | "organizationName" | "organizationType" | "organizationRole" | "billingType" | "seatTier">;

/** What reading an identity's stored login yields: its account metadata, or why that could not be read. Undefined for an identity with no stored login. */
export type IdentityAccountRead = { readonly account: AccountMetadata; readonly problem?: never } | { readonly problem: string; readonly account?: never } | undefined;

/**
 * Reads one identity's account metadata for a listing. An unreadable `.claude.json` is reported as that identity's own problem, never thrown: one bad profile must not hide every other identity from `identity list`, the same rule `listIdentities` applies to a bad `identity.json`.
 */
export function readIdentityAccount(fs: Pick<FarmFs, "readFileUtf8">, identitiesDir: string, identity: string): IdentityAccountRead {
  try {
    const account = readAccountMetadata(fs, identitiesDir, identity);
    return account === undefined ? undefined : { account };
  } catch (error) {
    if (error instanceof AccountMetadataError) {
      return { problem: error.message };
    }
    throw error;
  }
}

/** The summary fields `account` carries, or undefined when it carries none of them. */
export function summariseIdentityAccount(account: Readonly<AccountMetadata>): IdentityAccountSummary | undefined {
  const summary: IdentityAccountSummary = {
    ...(account.emailAddress === undefined ? {} : { emailAddress: account.emailAddress }),
    ...(account.organizationName === undefined ? {} : { organizationName: account.organizationName }),
    ...(account.organizationType === undefined ? {} : { organizationType: account.organizationType }),
    ...(account.organizationRole === undefined ? {} : { organizationRole: account.organizationRole }),
    ...(account.billingType === undefined ? {} : { billingType: account.billingType }),
    ...(account.seatTier === undefined ? {} : { seatTier: account.seatTier }),
  };
  return Object.keys(summary).length === 0 ? undefined : summary;
}

/**
 * The key two identities share exactly when they hold the same login: the same account in the same organisation. Undefined without an account uuid, since nothing then says whose login it is. A login with no organisation uuid keys on the account alone, so it matches only another organisation-less login of that account.
 */
export function loginKeyOf(account: Readonly<AccountMetadata>): string | undefined {
  return account.accountUuid === undefined ? undefined : JSON.stringify([account.accountUuid, account.organizationUuid ?? null]);
}

/** Collects `items` by the login `loginOf` names, in order of each login's first member. An item with no login gets a group of its own, so it never groups with another. */
function collectByLogin<T>(items: readonly T[], loginOf: (item: T) => string | undefined): readonly (readonly T[])[] {
  const groups = new Map<string | symbol, T[]>();
  for (const item of items) {
    const key = loginOf(item) ?? Symbol("no login");
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return [...groups.values()];
}

/** Reorders `items` so those sharing a login sit together, the group at the position of its first member, members in given order. An item with no login keeps its place. */
export function groupByLogin<T>(items: readonly T[], loginOf: (item: T) => string | undefined): readonly T[] {
  return collectByLogin(items, loginOf).flat();
}

/** The groups of two or more `items` that share one login, each in given order and ordered by its first member. An item with no login, or the only one holding its login, is in no group. */
export function groupSharedLogins<T>(items: readonly T[], loginOf: (item: T) => string | undefined): readonly (readonly T[])[] {
  return collectByLogin(items, loginOf).filter((group) => group.length > 1);
}

/** Who an identity's login is, in the wording `account show` uses: `email (organisation)`, or the organisation alone when the login has no email. Undefined when it has neither. */
export function describeAccountHolder(summary: Readonly<IdentityAccountSummary>): string | undefined {
  const organisation = describeAccountOrganisation(summary);
  if (summary.emailAddress === undefined) {
    return organisation;
  }
  return organisation === undefined ? summary.emailAddress : `${summary.emailAddress} (${organisation})`;
}

/** One line for an identity's account: `email (organisation); role <role>; <plan>`, each part only when the login has it. */
export function describeIdentityAccount(summary: Readonly<IdentityAccountSummary>): string {
  return [describeAccountHolder(summary), summary.organizationRole === undefined ? undefined : `role ${summary.organizationRole}`, describeAccountPlan(summary)].filter((part) => part !== undefined).join("; ");
}
