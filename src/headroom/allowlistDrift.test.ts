import { describe, expect, it } from "vitest";

import { ProviderSchema } from "../config/schema";
import { diagnoseAllowlistDrift } from "./allowlistDrift";
import { hashAllowlist, headroomAllowlist, headroomUpstreams } from "./state";

const DOOR_ORIGIN = "http://127.0.0.1:50123";
const MOVED_DOOR_ORIGIN = "http://127.0.0.1:50999";

function provider(baseUrl: string) {
  return ProviderSchema.parse({ displayName: "P", baseUrl, credential: { sources: [{ env: "T" }] } });
}

const providers = [provider("https://api.z.ai/api/anthropic")];

function hashFor(inputs: Parameters<typeof headroomUpstreams>) {
  return hashAllowlist(headroomAllowlist(headroomUpstreams(...inputs)));
}

describe("diagnoseAllowlistDrift", () => {
  it("reports no drift when the recorded hash matches the current inputs", () => {
    const recordedHash = hashFor([providers, DOOR_ORIGIN]);
    expect(diagnoseAllowlistDrift({ recordedHash, providers, frontDoorOrigin: DOOR_ORIGIN })).toBeUndefined();
  });

  it("reports nothing when no daemon hash was recorded", () => {
    expect(diagnoseAllowlistDrift({ recordedHash: undefined, providers, frontDoorOrigin: DOOR_ORIGIN })).toBeUndefined();
  });

  it("names the door origin alone when the daemon was started before the door had an origin", () => {
    const recordedHash = hashFor([providers, undefined]);
    expect(diagnoseAllowlistDrift({ recordedHash, providers, frontDoorOrigin: DOOR_ORIGIN })).toEqual(["front-door-origin"]);
  });

  it("names both inputs when the door's origin moved, since the old origin is not recorded", () => {
    const recordedHash = hashFor([providers, MOVED_DOOR_ORIGIN]);
    expect(diagnoseAllowlistDrift({ recordedHash, providers, frontDoorOrigin: DOOR_ORIGIN })).toEqual(["provider-files", "front-door-origin"]);
  });

  it("names only the provider files when no provider routes through the door's origin", () => {
    const recordedHash = hashFor([[], undefined]);
    expect(diagnoseAllowlistDrift({ recordedHash, providers: [], frontDoorOrigin: DOOR_ORIGIN })).toBeUndefined();
    const changed = hashFor([[provider("https://old.example.com")], undefined]);
    expect(diagnoseAllowlistDrift({ recordedHash: changed, providers: [], frontDoorOrigin: undefined })).toEqual(["provider-files"]);
  });
});
