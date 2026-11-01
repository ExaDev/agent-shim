import { describeAccountHolder, groupSharedLogins, joinNames, loginKeyOf, summariseIdentityAccount } from "./identityAccounts";
import { poolNameOf } from "./launcher/identity";
import type { AccountMetadata } from "./usage/schema";

/** One set of two or more of a pool's direct members that hold the same login, with the account they share. */
interface SharedLoginMembers {
  readonly members: readonly string[];
  readonly account: AccountMetadata;
}

/**
 * The sets of direct members of a pool that hold one login (the same account in the same organisation, `loginKeyOf`), each in listed order and ordered by its first member. `members` are the pool's entries as written: a nested `pool:<name>` entry has no account of its own and is never grouped, and neither is a member `accountOf` has no account uuid for.
 */
export function sharedLoginMembers(members: readonly string[], accountOf: (identity: string) => AccountMetadata | undefined): readonly SharedLoginMembers[] {
  const known = members.flatMap((identity) => {
    const account = poolNameOf(identity) === undefined ? accountOf(identity) : undefined;
    return account === undefined ? [] : [{ identity, account }];
  });
  return groupSharedLogins(known, (entry) => loginKeyOf(entry.account)).flatMap((group) => {
    const first = group[0];
    return first === undefined ? [] : [{ members: group.map((entry) => entry.identity), account: first.account }];
  });
}

/** The warning for one set of members of `poolName` that hold a login, naming the login the way `account show` does when it has a name. */
export function describeSharedLoginMembers(poolName: string, shared: Readonly<SharedLoginMembers>): string {
  const summary = summariseIdentityAccount(shared.account);
  const holder = summary === undefined ? undefined : describeAccountHolder(summary);
  return `Pool "${poolName}" lists ${joinNames(shared.members)}, which hold the same login${holder === undefined ? "" : ` (${holder})`}, so they share one quota window. A launch ranks them as one candidate and never fails over from one to another; keep one of them in the pool.`;
}
