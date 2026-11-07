import { ConfigValidationError } from "../config/load";
import type { LayoutPaths } from "../paths";
import { selectedProviderName } from "../providersStore";
import type { CascadeInput } from "../resolve/walk";
import type { ProviderOf } from "../usage/poolPick";
import { decideConfigProfile, identityReader, type IdentityReader } from "./identity";
import type { FsPort } from "./ports";

/** What the provider a launch of a pool member routes through is decided from: the launch's own selections, and the facts each member adds. */
export interface MemberProviderParams {
  readonly paths: LayoutPaths;
  readonly fs: FsPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The launch's `--provider` flag: a provider name, `false` for `--no-provider`, undefined when neither was given. */
  readonly cliProvider: string | false | undefined;
  /** The configuration profile the launch's flag names, which outranks every other source of one. */
  readonly cliFlagConfigProfile?: string;
  /** The configuration profile a directory rule or a committed file selects for the launch directory. */
  readonly directoryRuleConfigProfile?: string;
  /** The global default configuration profile. */
  readonly globalDefaultConfigProfile?: string;
  /** Assembles the cascade for the launch directory over a base configuration profile, as a launch does for the identity it runs as. */
  readonly loadCascade: (baseConfigProfile: string | undefined) => CascadeInput;
}

/**
 * The provider each pool member's launch would route through, resolved the way the launch resolves it for the member it runs as: the `--provider` flag, then a provider a cascade layer selects (over the configuration profile that member would launch with), then the member's own `provider`, with a renamed provider named by what it became. A launch that opted out with `--no-provider` routes no member through one.
 *
 * Reads no credential and resolves no provider definition, so ranking a pool never touches a secret store. A name no provider file defines is returned as named, since refusing it is the launch's job once a member is picked. Each identity file is read once and each distinct cascade assembled once, however many members ask. A member whose identity file fails validation is resolved from the launch's own selections alone: picking it fails with that file's own error, exactly as it did before providers entered the ranking, and ranking the others does not need it.
 */
export function memberProviderResolver(params: MemberProviderParams): ProviderOf {
  if (params.cliProvider === false) {
    return () => undefined;
  }
  const cliProvider = params.cliProvider;
  const identities = identityReader(params.paths.identitiesDir, params.fs);
  const cascades = new Map<string | undefined, CascadeInput>();
  const cascadeOver = (baseConfigProfile: string | undefined): CascadeInput => {
    const cached = cascades.get(baseConfigProfile);
    if (cached !== undefined) {
      return cached;
    }
    const loaded = params.loadCascade(baseConfigProfile);
    cascades.set(baseConfigProfile, loaded);
    return loaded;
  };
  return (name) => {
    let declared: ReturnType<IdentityReader["load"]>;
    try {
      declared = identities.load(name);
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) {
        throw error;
      }
    }
    const profile = decideConfigProfile({
      env: params.env,
      ...(params.cliFlagConfigProfile === undefined ? {} : { cliFlagConfigProfile: params.cliFlagConfigProfile }),
      ...(params.directoryRuleConfigProfile === undefined ? {} : { directoryRuleConfigProfile: params.directoryRuleConfigProfile }),
      ...(declared?.defaultConfigProfile === undefined ? {} : { identityDefaultConfigProfile: declared.defaultConfigProfile }),
      ...(params.globalDefaultConfigProfile === undefined ? {} : { globalDefaultConfigProfile: params.globalDefaultConfigProfile }),
    });
    return selectedProviderName({
      paths: params.paths,
      port: params.fs,
      ...(cliProvider === undefined ? {} : { cliProvider }),
      cascade: cascadeOver(profile.name),
      ...(declared?.provider === undefined ? {} : { identityProvider: declared.provider }),
    });
  };
}
