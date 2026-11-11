import { describe, expect, it, vi } from "vitest";

import type { Pool } from "../config/schema";
import { parseLauncherArgv } from "./argv";
import { LAUNCH_CANCELLED_EXIT } from "./hold";
import { decideIdentity } from "./identity";
import type { IdentityPickerPort, PickerAnswer, PickerRequest } from "./ports";
import { IdentityPickerCancelledError, NoIdentityToPickError, runIdentityPicker, type PickerOutcome } from "./runPicker";
import { createFakeFarmFs, FAKE_NOW_MS, fakeFarm, fakeFs, paths } from "../test-helpers";
import { readStickyPick, recordStickyPick } from "../usage/poolPick";

const HOUR_MS = 3_600_000;
const HOURS_PER_DAY = 24;
const SIX_DAYS_MS = 518_400_000;
const U10 = 0.1;
const U60 = 0.6;
const FULL = 1;
const CWD = fakeFarm(createFakeFarmFs()).cwd;

const iso = (offsetMs: number): string => new Date(FAKE_NOW_MS + offsetMs).toISOString();
const snapshotPath = (identity: string): string => `${paths.usageSnapshotsDir}/${identity}.json`;
const loginPath = (identity: string): string => `${paths.identitiesDir}/${identity}/.claude.json`;

/** An identity's stored login, as Claude Code writes it. */
function login(email: string, extra: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify({ oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email, ...extra } });
}

/** A usage snapshot with one seven-day window; a `rejected` status with no overage on offer refuses the identity. */
function snapshotOf(identity: string, sevenDay: { readonly utilization: number; readonly resetsInMs: number; readonly status?: string }): string {
  const seen = iso(-HOUR_MS);
  return JSON.stringify({
    schemaVersion: 1,
    identity,
    updatedAt: seen,
    providers: {
      anthropic: {
        lastRequestAt: seen,
        lastStatus: 200,
        rateLimit: { observedAt: seen, headers: {}, unified: { sevenDay: { utilization: sevenDay.utilization, resetsAt: iso(sevenDay.resetsInMs), ...(sevenDay.status === undefined ? {} : { status: sevenDay.status }) } } },
      },
    },
  });
}

/** Two accounts: `work` expires soon, so the pool picks it, and `personal` has plenty a week away. */
const TWO_ACCOUNTS: Readonly<Record<string, string>> = {
  [loginPath("work")]: login("alex@example.com", { organizationUuid: "org-1", organizationName: "Example Org", organizationType: "claude_team", organizationRole: "admin" }),
  [loginPath("personal")]: login("sam@example.com"),
  [snapshotPath("work")]: snapshotOf("work", { utilization: U60, resetsInMs: HOUR_MS }),
  [snapshotPath("personal")]: snapshotOf("personal", { utilization: U10, resetsInMs: SIX_DAYS_MS }),
};

const POOLS: Readonly<Record<string, Pool>> = { main: { identities: ["work", "personal"] } };

/** A picker that answers every question with `answer`. */
function scriptedPicker(answer: PickerAnswer): IdentityPickerPort {
  return { pick: async () => Promise.resolve(answer) };
}

interface Setup {
  readonly argv?: readonly string[];
  readonly seed?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly pools?: Readonly<Record<string, Pool>>;
  readonly active?: string;
  readonly picker?: IdentityPickerPort;
  readonly lastRanAs?: string;
  readonly providerOf?: (identity: string) => string | undefined;
  readonly identityNames?: readonly string[];
}

async function run(setup: Setup = {}): Promise<{ readonly outcome: PickerOutcome; readonly requests: readonly PickerRequest[]; readonly farmFs: ReturnType<typeof createFakeFarmFs> }> {
  const farmFs = createFakeFarmFs(setup.seed ?? TWO_ACCOUNTS);
  const farm = fakeFarm(farmFs);
  if (setup.lastRanAs !== undefined) {
    recordStickyPick(farmFs, paths.usagePicksFile, farm.cwd, setup.lastRanAs, FAKE_NOW_MS - HOUR_MS * 2);
  }
  const answering = setup.picker ?? scriptedPicker({ kind: "cancelled" });
  const requests: PickerRequest[] = [];
  const picker: IdentityPickerPort = {
    pick: async (request) => {
      requests.push(request);
      return await answering.pick(request);
    },
  };
  const argv = setup.argv ?? [];
  const parsed = parseLauncherArgv(argv);
  const outcome = await runIdentityPicker({
    parsed,
    decision: decideIdentity({ env: {}, argv0Identity: parsed.identity, readActiveIdentityFile: () => setup.active }),
    interactive: setup.interactive ?? true,
    paths,
    fs: fakeFs({ [`${paths.identitiesDir}/spare/identity.json`]: { name: "spare", allowAmbientCredential: false } }),
    usageFs: farmFs,
    pools: setup.pools ?? POOLS,
    cwd: farm.cwd,
    now: farm.now,
    identityNames: () => setup.identityNames ?? ["personal", "spare", "work"],
    ...(setup.providerOf === undefined ? {} : { providerOf: setup.providerOf }),
    picker,
  });
  return { outcome, requests, farmFs };
}

describe("runIdentityPicker without a reason to ask", () => {
  it("leaves a launch that names an identity alone", async () => {
    const { outcome, requests } = await run({ argv: ["@work"] });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("leaves a launch that has no terminal alone even when nothing resolves", async () => {
    const { outcome, requests } = await run({ interactive: false });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("leaves a pool launch alone when the directory has no earlier run to compare with", async () => {
    const { outcome, requests } = await run({ argv: ["@pool:main"] });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("leaves a print run alone even when nothing resolves", async () => {
    const { outcome, requests } = await run({ argv: ["-p", "hello"] });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("leaves a pool pick alone when the account it moves to is the one the directory last ran as", async () => {
    const seed = { ...TWO_ACCOUNTS, [loginPath("personal")]: TWO_ACCOUNTS[loginPath("work")] ?? "" };
    const { outcome, requests } = await run({ argv: ["@pool:main"], seed, lastRanAs: "personal" });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("leaves a pool pick alone when either login is not recorded, since nothing says the account changes", async () => {
    const seed = { ...TWO_ACCOUNTS, [loginPath("personal")]: JSON.stringify({}) };
    const { requests } = await run({ argv: ["@pool:main"], seed, lastRanAs: "personal" });
    expect(requests).toHaveLength(0);
  });
});

describe("runIdentityPicker when no identity resolves", () => {
  it("lists every identity and every pool with the account and quota recorded for each", async () => {
    const { requests } = await run({ picker: scriptedPicker({ kind: "picked", value: "spare" }) });
    const [request] = requests;
    expect(request?.entries.map((entry) => entry.value)).toEqual(["personal", "spare", "work", "pool:main"]);
    const work = request?.entries.find((entry) => entry.value === "work")?.label ?? "";
    expect(work).toContain("alex@example.com");
    expect(work).toContain("Example Org (admin)");
    expect(work).toContain("7d 60% used");
    const spare = request?.entries.find((entry) => entry.value === "spare")?.label;
    expect(spare).toBe("spare");
    expect(request?.entries.find((entry) => entry.value === "pool:main")?.label).toContain("work, personal");
    expect(request?.initial).toBeUndefined();
  });

  it("selects what the person chose", async () => {
    const { outcome } = await run({ picker: scriptedPicker({ kind: "picked", value: "personal" }) });
    expect(outcome).toEqual({ kind: "selected", selector: "personal" });
  });

  it("selects a pool the person chose", async () => {
    const { outcome } = await run({ picker: scriptedPicker({ kind: "picked", value: "pool:main" }) });
    expect(outcome).toEqual({ kind: "selected", selector: "pool:main" });
  });

  it("reports a cancel", async () => {
    const { outcome } = await run();
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("does not ask when the active selection resolves one", async () => {
    const { requests } = await run({ active: "work" });
    expect(requests).toHaveLength(0);
  });
});

describe("runIdentityPicker when nothing exists to choose from", () => {
  it("fails with the command that creates an identity, without asking", async () => {
    const asked: PickerRequest[] = [];
    const attempt = run({
      seed: {},
      pools: {},
      identityNames: [],
      picker: {
        pick: async (request) => {
          asked.push(request);
          return Promise.resolve({ kind: "cancelled" });
        },
      },
    });
    await expect(attempt).rejects.toThrow(NoIdentityToPickError);
    await expect(attempt).rejects.toThrow("agent-shim identity add <name>");
    expect(asked).toHaveLength(0);
  });
});

describe("runIdentityPicker when a pool pick would change account", () => {
  it("lists the pool's ranking as pool pick prints it, with the pick preselected", async () => {
    const { requests } = await run({ argv: ["@pool:main"], lastRanAs: "personal", picker: scriptedPicker({ kind: "picked", value: "work" }) });
    const [request] = requests;
    expect(request?.entries.map((entry) => entry.value)).toEqual(["work", "personal"]);
    expect(request?.initial).toBe("work");
    const first = request?.entries[0]?.label ?? "";
    expect(first).toContain("1. work [scored");
    expect(first).toContain("(picked)");
    expect(first).toContain("alex@example.com");
    expect(request?.entries[1]?.label).toContain("2. personal [scored");
    expect(request?.message).toContain("personal");
    expect(request?.message).toContain("work");
  });

  it("keeps the pool selected when the person accepts the pick, so the launch still picks and records it", async () => {
    const { outcome } = await run({ argv: ["@pool:main"], lastRanAs: "personal", picker: scriptedPicker({ kind: "picked", value: "work" }) });
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("runs as the member the person chose instead, and records it as the directory's last run", async () => {
    const { outcome, farmFs } = await run({ argv: ["@pool:main"], lastRanAs: "personal", picker: scriptedPicker({ kind: "picked", value: "personal" }) });
    expect(outcome).toEqual({ kind: "selected", selector: "personal" });
    expect(readStickyPick(farmFs, paths.usagePicksFile, CWD).sticky?.identity).toBe("personal");
  });

  it("changes nothing when the person cancels", async () => {
    const { outcome, farmFs } = await run({ argv: ["@pool:main"], lastRanAs: "personal" });
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(readStickyPick(farmFs, paths.usagePicksFile, CWD).sticky?.identity).toBe("personal");
  });
});

describe("runIdentityPicker when nothing can be used", () => {
  const REFUSED: Readonly<Record<string, string>> = {
    ...TWO_ACCOUNTS,
    [snapshotPath("work")]: snapshotOf("work", { utilization: FULL, resetsInMs: SIX_DAYS_MS, status: "rejected" }),
    [snapshotPath("personal")]: snapshotOf("personal", { utilization: FULL, resetsInMs: HOUR_MS, status: "rejected" }),
  };

  it("asks when the picked identity is refused, naming when it returns", async () => {
    const { requests } = await run({ argv: ["@work"], seed: REFUSED, picker: scriptedPicker({ kind: "picked", value: "spare" }) });
    const [request] = requests;
    expect(request?.entries.map((entry) => entry.value)).toEqual(["personal", "spare", "work", "pool:main"]);
    expect(request?.entries.find((entry) => entry.value === "work")?.label).toContain("refused until");
    expect(request?.initial).toBe("work");
  });

  it("asks when every member of the pool is refused, listing the ranking with the reason each is out", async () => {
    const { requests, outcome } = await run({ argv: ["@pool:main"], seed: REFUSED, picker: scriptedPicker({ kind: "picked", value: "personal" }) });
    const [request] = requests;
    expect(request?.entries.map((entry) => entry.value)).toEqual(["personal", "work"]);
    expect(request?.entries.every((entry) => entry.label.includes("refused until"))).toBe(true);
    expect(request?.initial).toBeUndefined();
    expect(outcome).toEqual({ kind: "selected", selector: "personal" });
  });

  it("does not ask about a refused pool when the launch waits for it", async () => {
    const { requests, outcome } = await run({ argv: ["@pool:main", "--wait"], seed: REFUSED });
    expect(requests).toHaveLength(0);
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("reports a cancel at a refused pool", async () => {
    const { outcome } = await run({ argv: ["@pool:main"], seed: REFUSED });
    expect(outcome).toEqual({ kind: "cancelled" });
  });
});

describe("runIdentityPicker under --pick", () => {
  it("asks for a named identity, with every identity listed and the named one preselected", async () => {
    const { requests, outcome } = await run({ argv: ["@work", "--pick"], picker: scriptedPicker({ kind: "picked", value: "work" }) });
    expect(requests[0]?.initial).toBe("work");
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("selects another identity when the person chooses one", async () => {
    const { outcome } = await run({ argv: ["@work", "--pick"], picker: scriptedPicker({ kind: "picked", value: "personal" }) });
    expect(outcome).toEqual({ kind: "selected", selector: "personal" });
  });

  it("asks for a pool launch, listing the pool's ranking with the pick preselected", async () => {
    const { requests } = await run({ argv: ["@pool:main", "--pick"], picker: scriptedPicker({ kind: "picked", value: "work" }) });
    expect(requests[0]?.entries.map((entry) => entry.value)).toEqual(["work", "personal"]);
    expect(requests[0]?.initial).toBe("work");
  });

  it("asks even for a print run, since the person typed the flag", async () => {
    const { requests } = await run({ argv: ["@work", "--pick", "-p", "hello"], picker: scriptedPicker({ kind: "picked", value: "work" }) });
    expect(requests).toHaveLength(1);
  });

  it("does not ask without a terminal", async () => {
    const { requests, outcome } = await run({ argv: ["@work", "--pick"], interactive: false });
    expect(requests).toHaveLength(0);
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("does not ask under --no-pick even when nothing resolves", async () => {
    const { requests, outcome } = await run({ argv: ["--no-pick"] });
    expect(requests).toHaveLength(0);
    expect(outcome).toEqual({ kind: "unchanged" });
  });
});

describe("runIdentityPicker's picker", () => {
  it("waits on the person with no timeout of its own", async () => {
    vi.useFakeTimers();
    try {
      let answer: ((value: PickerAnswer) => void) | undefined;
      const picker: IdentityPickerPort = { pick: async () => await new Promise<PickerAnswer>((resolve) => { answer = resolve; }) };
      const pending = run({ picker });
      await vi.advanceTimersByTimeAsync(HOURS_PER_DAY * HOUR_MS);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      answer?.({ kind: "picked", value: "work" });
      expect((await pending).outcome).toEqual({ kind: "selected", selector: "work" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("IdentityPickerCancelledError", () => {
  it("ends the launch with the interrupt status and says no identity was chosen", () => {
    const error = new IdentityPickerCancelledError();
    expect(error.exitCode).toBe(LAUNCH_CANCELLED_EXIT);
    expect(error.message).toContain("cancelled at the identity picker");
  });
});

describe("runIdentityPicker for a launch that spends a provider", () => {
  /** An identity whose Claude week is spent and whose provider `p` week is open. */
  function spentClaudeOpenProvider(identity: string): string {
    const snapshot = JSON.parse(snapshotOf(identity, { utilization: FULL, resetsInMs: SIX_DAYS_MS, status: "rejected" })) as { providers: Record<string, unknown> };
    snapshot.providers.p = { lastRequestAt: iso(-HOUR_MS), lastStatus: 200, rateLimit: { observedAt: iso(-HOUR_MS), headers: {}, unified: { sevenDay: { utilization: U10, resetsAt: iso(SIX_DAYS_MS) } } } };
    return JSON.stringify(snapshot);
  }

  const SEED = { [snapshotPath("work")]: spentClaudeOpenProvider("work"), [snapshotPath("personal")]: spentClaudeOpenProvider("personal") };

  it("asks which identity to run as when every member is refused on the Claude account", async () => {
    const { requests } = await run({ argv: ["@pool:main"], seed: SEED });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toContain("refused right now");
  });

  it("does not ask when the provider the launch spends has room, whatever the Claude account has left", async () => {
    const { outcome, requests } = await run({ argv: ["@pool:main", "--provider", "p"], seed: SEED, providerOf: () => "p" });
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(requests).toHaveLength(0);
  });

  it("lists each member with the provider it was ranked on when asked with --pick", async () => {
    const { requests } = await run({ argv: ["@pool:main", "--provider", "p", "--pick"], seed: SEED, providerOf: () => "p" });
    const labels = requests[0]?.entries.map((entry) => entry.label) ?? [];
    expect(labels).toHaveLength(2);
    expect(labels.every((label) => label.includes("on provider p"))).toBe(true);
  });
});
