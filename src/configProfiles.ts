import type { Command } from "commander";
import type { ConfigProfile, LaunchFlags } from "./config/schema";
import { confirmRemoval, printJson, withExamples, type CommandDeps } from "./cli/commandDeps";
import { collectBoolPair, collectRepeated } from "./cli/parsers";
import { PromptCancelledError, UsageError } from "./cliError";
import { runProfileWizard } from "./configure";
import type { LayoutPaths } from "./paths";
import { ProfileNotFoundError, profileExists, requireProfileExists, readProfile, createProfile, listProfiles, readGlobalConfig, setGlobalDefaultProfile, setProfileCategories, setProfileEntries, setProfileLaunchFlags, setProfileMetadata, removeProfile } from "./configProfilesStore";

/**
 * Makes sure configuration profile `name` exists before something is pointed at it (`identity set --default-profile`, `rule add --config-profile`, `profile use`). An existing profile passes straight through. A missing one is offered for creation, via `runProfileWizard` under that exact name, when standard input is a terminal; declining raises `PromptCancelledError`. With no terminal it raises `ProfileNotFoundError`, since there is nothing to prompt on and pointing at a missing profile would only fail later.
 */
export async function ensureProfileExists(deps: CommandDeps, name: string): Promise<void> {
  if (profileExists(deps.paths, name)) {
    return;
  }
  if (!deps.isInteractive()) {
    throw new ProfileNotFoundError(name);
  }
  const choice = await deps.prompts.select({
    message: `No configuration profile named "${name}" exists yet. Create it now?`,
    options: [
      { value: "create", label: "Create it and choose categories" },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (deps.prompts.isCancel(choice) || choice === "cancel") {
    throw new PromptCancelledError();
  }
  if ((await runProfileWizard(deps.prompts, { paths: deps.paths, createName: name })) === undefined) {
    throw new PromptCancelledError();
  }
}

/** One profile as `profile show --json` and `profile list --json` print it: the file's own content (less its editor-only `$schema` pointer) plus its name and whether it is the global default. */
function toProfileView(name: string, profile: ConfigProfile, globalDefault: string | undefined): Record<string, unknown> {
  return { name, globalDefault: name === globalDefault, ...profile, $schema: undefined };
}

/** Options `profile add` accepts. */
interface ProfileAddOptions {
  readonly extends?: readonly string[];
  readonly description?: string;
}

/** Options `profile set` accepts. Each `launch*` value is `false` for its `--no-` form. */
interface ProfileSetOptions {
  readonly category?: Record<string, boolean>;
  readonly entry?: Record<string, boolean>;
  readonly extends?: readonly string[] | false;
  readonly description?: string | false;
  readonly launchSkipPermissions?: boolean;
  readonly launchRemoteControl?: boolean;
  readonly launchHeadroom?: boolean;
  readonly launchTrackUsage?: boolean;
  readonly launchProvider?: string | false;
}

/** Applies every field `profile set`'s options name, returning whether any were given. */
function applyProfileSet(paths: LayoutPaths, name: string, options: ProfileSetOptions): boolean {
  let touched = false;
  if (options.category !== undefined) {
    setProfileCategories(paths, name, options.category);
    touched = true;
  }
  if (options.entry !== undefined) {
    setProfileEntries(paths, name, options.entry);
    touched = true;
  }
  if (options.extends !== undefined || options.description !== undefined) {
    setProfileMetadata(paths, name, {
      ...(options.extends === undefined ? {} : { extends: options.extends === false ? [] : options.extends }),
      ...(options.description === undefined ? {} : { description: options.description }),
    });
    touched = true;
  }
  const launchPatch: LaunchFlags = {};
  if (options.launchSkipPermissions !== undefined) {
    launchPatch.skipPermissions = options.launchSkipPermissions;
  }
  if (options.launchRemoteControl !== undefined) {
    launchPatch.remoteControl = options.launchRemoteControl;
  }
  if (options.launchHeadroom !== undefined) {
    launchPatch.headroom = options.launchHeadroom;
  }
  if (options.launchTrackUsage !== undefined) {
    launchPatch.trackUsage = options.launchTrackUsage;
  }
  if (options.launchProvider !== undefined) {
    launchPatch.provider = options.launchProvider === false ? undefined : options.launchProvider;
  }
  if (Object.keys(launchPatch).length > 0) {
    setProfileLaunchFlags(paths, name, launchPatch);
    touched = true;
  }
  return touched;
}

/** Registers the `agent-shim profile` subcommand tree onto `program`. */
export function registerProfileCommand(program: Command, deps: CommandDeps): void {
  const { paths } = deps;
  const profile = withExamples(
    program
      .command("profile")
      .description("Manage configuration profiles: named, reusable rules for what an identity shares with ~/.claude."),
    ["agent-shim profile add client-acme", "agent-shim profile list"],
  );

  withExamples(
    profile
      .command("add [name]")
      .description(
        "Create a new configuration profile. Fails if one with this name already exists. With no options on a terminal, walks through choosing its categories.",
      )
      .option("--extends <profile>", "A profile this one extends (repeatable, in order).", collectRepeated)
      .option("--description <text>", "A free-text description stored in the profile.")
      .action(async (name: string | undefined, options: ProfileAddOptions) => {
        const hasOptions = options.extends !== undefined || options.description !== undefined;
        if (!hasOptions && deps.isInteractive()) {
          const result = await runProfileWizard(deps.prompts, name === undefined ? { paths } : { paths, createName: name });
          if (result === undefined) {
            throw new PromptCancelledError();
          }
          console.log(`Created configuration profile "${result.name}".`);
          return;
        }
        if (name === undefined) {
          throw new UsageError("missing required argument 'name' (standard input is not a terminal, so there is nothing to prompt on).");
        }
        createProfile(paths, name, options.extends, options.description);
        console.log(`Created configuration profile "${name}".`);
      }),
    ["agent-shim profile add client-acme", "agent-shim profile add client-acme --extends work-default --extends strict"],
  );

  withExamples(
    profile
      .command("set <name>")
      .description(
        "Update a configuration profile's categories, entries, extends list, description or launch settings. With no options on a terminal, walks through its categories.",
      )
      .option("--category <category=bool>", "Share (true) or hide (false) a whole category (repeatable).", collectBoolPair)
      .option("--entry <path=bool>", "Share (true) or hide (false) one <category>/<path> entry (repeatable).", collectBoolPair)
      .option("--extends <profile>", "Replace the extends list with these profiles (repeatable, in order).", collectRepeated)
      .option("--no-extends", "Clear the extends list.")
      .option("--description <text>", "Replace the description.")
      .option("--no-description", "Clear the description.")
      .option("--launch-skip-permissions", "Launches under this profile skip permission prompts.")
      .option("--no-launch-skip-permissions", "Launches under this profile keep permission prompts.")
      .option("--launch-remote-control", "Launches under this profile enable Remote Control.")
      .option("--no-launch-remote-control", "Launches under this profile leave Remote Control off.")
      .option("--launch-headroom", "Launches under this profile route through headroom.")
      .option("--no-launch-headroom", "Launches under this profile route direct.")
      .option("--launch-track-usage", "Launches under this profile route through the front door so their requests and quota are recorded, with no headroom needed.")
      .option("--no-launch-track-usage", "Launches under this profile are not recorded unless a provider or headroom routes them anyway.")
      .option("--launch-provider <provider>", "Launches under this profile route through this provider.")
      .option("--no-launch-provider", "Clear this profile's provider selection.")
      .action(async (name: string, options: ProfileSetOptions) => {
        requireProfileExists(paths, name);
        if (Object.values(options).every((value) => value === undefined)) {
          if (!deps.isInteractive()) {
            throw new UsageError(
              "Nothing to change: pass --category, --entry, --extends, --description or a --launch-* option (standard input is not a terminal, so there is nothing to prompt on).",
            );
          }
          if ((await runProfileWizard(deps.prompts, { paths, existingName: name })) === undefined) {
            throw new PromptCancelledError();
          }
        } else {
          applyProfileSet(paths, name, options);
        }
        console.log(`Updated configuration profile "${name}".`);
      }),
    [
      "agent-shim profile set client-acme --category history=false --category knowledge=true",
      'agent-shim profile set client-acme --entry "knowledge/skills/commit=false"',
      "agent-shim profile set client-acme --launch-headroom --launch-provider z",
    ],
  );

  withExamples(
    profile
      .command("list")
      .description("List every configuration profile, marking the global default with *.")
      .option("--json", "Print the profiles as JSON.")
      .action((options: Readonly<{ json?: boolean }>) => {
        const entries = listProfiles(paths);
        const globalDefault = readGlobalConfig(paths)?.defaultConfigProfile;
        if (options.json === true) {
          printJson(entries.map((entry) => toProfileView(entry.name, entry.profile, globalDefault)));
          return;
        }
        if (entries.length === 0) {
          console.log("No configuration profiles yet. Run `agent-shim profile add <name>` to create one.");
          return;
        }
        for (const entry of entries) {
          const marker = entry.name === globalDefault ? "* " : "  ";
          const extendsSuffix =
            entry.profile.extends !== undefined && entry.profile.extends.length > 0
              ? ` (extends ${entry.profile.extends.join(", ")})`
              : "";
          console.log(`${marker}${entry.name}${extendsSuffix}`);
        }
      }),
    ["agent-shim profile list", "agent-shim profile list --json"],
  );

  withExamples(
    profile
      .command("show <name>")
      .description("Show one configuration profile's contents.")
      .option("--json", "Print the profile as JSON.")
      .action((name: string, options: Readonly<{ json?: boolean }>) => {
        const found = readProfile(paths, name);
        if (found === undefined) {
          throw new ProfileNotFoundError(name);
        }
        const view = toProfileView(name, found, readGlobalConfig(paths)?.defaultConfigProfile);
        if (options.json === true) {
          printJson(view);
          return;
        }
        console.log(`Configuration profile: ${name}${view.globalDefault === true ? " (global default)" : ""}`);
        if (found.description !== undefined) {
          console.log(`Description: ${found.description}`);
        }
        console.log(`Extends: ${found.extends === undefined || found.extends.length === 0 ? "(nothing)" : found.extends.join(", ")}`);
        for (const [label, value] of [
          ["Categories", found.categories],
          ["Entries", found.entries],
          ["Launch", found.launch],
        ] as const) {
          const pairs = value === undefined ? [] : Object.entries(value);
          console.log(`${label}: ${pairs.length === 0 ? "(none)" : pairs.map(([key, setting]) => `${key}=${JSON.stringify(setting)}`).join(", ")}`);
        }
      }),
    ["agent-shim profile show client-acme", "agent-shim profile show client-acme --json"],
  );

  withExamples(
    profile
      .command("remove <name>")
      .description("Delete a configuration profile's file. References to it by name are left for `agent-shim doctor` to report.")
      .option("--yes", "Remove without asking for confirmation (required when standard input is not a terminal).")
      .action(async (name: string, options: Readonly<{ yes?: boolean }>) => {
        requireProfileExists(paths, name);
        await confirmRemoval(deps, options.yes, `configuration profile "${name}"`);
        removeProfile(paths, name);
        console.log(`Removed configuration profile "${name}".`);
      }),
    ["agent-shim profile remove client-acme --yes"],
  );

  withExamples(
    profile
      .command("use <name>")
      .description("Make a configuration profile the global default, used when no directory rule or identity selects one.")
      .action(async (name: string) => {
        await ensureProfileExists(deps, name);
        setGlobalDefaultProfile(paths, name);
        console.log(`Global default configuration profile is now "${name}".`);
      }),
    ["agent-shim profile use work-default"],
  );
}
