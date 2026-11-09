import { summariseCredential } from "./credential";
import type { Identity } from "./config/schema";

/**
 * One identity as a write reports it, here and in the door's configuration API: the fields of its `identity.json` that matter to a reader, with the credential block reduced to the target and the kind of each source (`summariseCredential`), because a literal's value or a command's arguments can be the secret itself.
 */
export function identityWriteView(identity: Identity) {
  return {
    ...(identity.agent === undefined ? {} : { agent: identity.agent }),
    name: identity.name,
    ...(identity.label === undefined ? {} : { label: identity.label }),
    ...(identity.defaultConfigProfile === undefined ? {} : { defaultConfigProfile: identity.defaultConfigProfile }),
    ...(identity.provider === undefined ? {} : { provider: identity.provider }),
    allowAmbientCredential: identity.allowAmbientCredential,
    ...(identity.credential === undefined ? {} : { credential: summariseCredential(identity.credential) }),
    ...(identity.anchors === undefined ? {} : { anchors: identity.anchors }),
  };
}
