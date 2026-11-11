import { isHttpProvider } from "./config/schema";
import type { DoctorSection, DoctorSeverity } from "./doctorReport";
import type { LayoutPaths } from "./paths";
import { catalogueSettingsFingerprint } from "./providerCatalogue";
import { readProvider } from "./providersStore";

/** Warns that a provider's catalogue refresh met a redirect a catalogue read does not follow, which is what a base URL that redirects from http to https meets: the request carries the provider's credential and a redirect target is another origin. The message names the provider and the setting to change, and no address. */
export function pushCatalogueRedirectFinding(push: (section: DoctorSection, severity: DoctorSeverity, message: string, subject?: string) => void, providerName: string, reason: string): void {
  push("provider", "warn", `The catalogue refresh of provider ${JSON.stringify(providerName)} reached a redirect, which a catalogue read never follows (its request carries the provider's credential, and a redirect target is another origin), so its catalogue is not being kept current. Set the provider's base URL (or its catalogue.url) to the address it redirects to, which running agent-shim provider models <name> --refresh from a shell prints. The refresh recorded: ${JSON.stringify(reason)}.`, providerName);
}

/** The settings fingerprint of the `http` provider `name` as its file reads now, or `undefined` for one that is no valid `http` provider or has no catalogue (no redirect warning is made for either: the first has its own finding, and the second is kept current by nobody). */
export function currentCatalogueSettings(paths: LayoutPaths, name: string): string | undefined {
  try {
    const provider = readProvider(paths, name);
    return provider === undefined || !isHttpProvider(provider) || provider.catalogue === undefined ? undefined : catalogueSettingsFingerprint(provider);
  } catch {
    // An invalid provider file is the provider section's finding; here it only means there is no current fingerprint to match a recorded failure against.
    return undefined;
  }
}
