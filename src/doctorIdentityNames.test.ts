import { describe, expect, it } from "vitest";
import { runDoctor } from "./doctorReport";
import { baseParams, findingsFor, identity } from "./doctorTestFixtures";

/** The fixture of an identity named `name` stored in the directory of id `id`. */
function stored(id: string, name: string): ReturnType<typeof identity> {
  return identity(name, { id, path: `/agent-shim/identities/${id}/identity.json`, raw: JSON.stringify({ name, allowAmbientCredential: false }), farmRoot: `/agent-shim/identities/${id}` });
}

describe("doctor and identity names", () => {
  it("fails a name two identities claim, naming both directories", () => {
    const report = runDoctor(baseParams({ identities: [stored("work", "client"), stored("other", "client")], identityRecords: { all: [{ id: "other", name: "client" }, { id: "work", name: "client" }], displaced: [] } }));
    const failed = findingsFor(report, "identity").filter((finding) => finding.severity === "fail");
    expect(failed.map((finding) => finding.message)).toContainEqual(expect.stringContaining('Identity name "client" is claimed by more than one identity (identities/other, identities/work)'));
  });

  it("reports no duplicate for an identity.json whose name cannot be read beside an identity that holds its directory's name", () => {
    const report = runDoctor(baseParams({ identities: [{ ...stored("client", "client"), raw: "{ not json" }, stored("work", "client")], identityRecords: { all: [{ id: "client", name: undefined }, { id: "work", name: "client" }], displaced: [] } }));
    const messages = findingsFor(report, "identity").map((finding) => finding.message);
    expect(messages.filter((message) => message.includes("claimed by more than one identity"))).toEqual([]);
    expect(messages.some((message) => message.includes("client") && message.includes("not valid JSON"))).toBe(true);
  });

  it("finds nothing wrong with an identity whose name differs from its directory's", () => {
    const report = runDoctor(baseParams({ identities: [stored("work", "client")], identityRecords: { all: [{ id: "work", name: "client" }], displaced: [] } }));
    const flagged = findingsFor(report, "identity").filter((finding) => finding.severity !== "pass");
    expect(flagged).toEqual([]);
  });

  it("warns of an identity whose directory is missing while a superseded farm holds its record, and says the next launch puts it back", () => {
    const report = runDoctor(baseParams({ identityRecords: { all: [], displaced: [{ id: "work", name: "client", directoryPresent: false }] } }));
    const warned = findingsFor(report, "identity").filter((finding) => finding.severity === "warn");
    expect(warned.map((finding) => finding.message)).toEqual(['Identity "client" has no identity.json in identities/work, which is missing: its identity.json is in a superseded farm a resync left when it was interrupted. The next launch of "client" puts it back.']);
  });

  it("says to launch by its id an identity whose displaced identity.json gives no name that can be read, since the id reaches it", () => {
    const report = runDoctor(baseParams({ identityRecords: { all: [], displaced: [{ id: "work", name: undefined, directoryPresent: false }] } }));
    const warned = findingsFor(report, "identity").filter((finding) => finding.severity === "warn");
    expect(warned.map((finding) => finding.message)).toEqual([
      "The identity stored under identities/work has no identity.json in identities/work, which is missing: its identity.json is in a superseded farm a resync left when it was interrupted. Its identity.json gives no name that can be read, so launch it by its id (`agent-shim run @work`) to put it back, then repair the file.",
    ]);
  });

  it("does not say to launch by its id an identity whose id another identity holds as its name, which a launch by that id would reach", () => {
    const report = runDoctor(baseParams({ identityRecords: { all: [{ id: "noname-2", name: "noname" }], displaced: [{ id: "noname", name: undefined, directoryPresent: false }] } }));
    const warned = findingsFor(report, "identity").filter((finding) => finding.severity === "warn");
    expect(warned.map((finding) => finding.message)).toEqual([
      'The identity stored under identities/noname has no identity.json in identities/noname, which is missing: its identity.json is in a superseded farm a resync left when it was interrupted. Its identity.json gives no name that can be read, and its id is the name of another identity, so a launch by its id reaches that one: repair the file in the superseded farm and launch it by the name the file gives, or rename the identity named "noname" first and then launch this one by its id (`agent-shim run @noname`) to put it back.',
    ]);
  });

  it("says the directory holds no identity.json yet, rather than that it is missing, when the directory is there", () => {
    const report = runDoctor(baseParams({ identityRecords: { all: [], displaced: [{ id: "work", name: "client", directoryPresent: true }] } }));
    const warned = findingsFor(report, "identity").filter((finding) => finding.severity === "warn");
    expect(warned.map((finding) => finding.message)).toEqual([expect.stringContaining("has no identity.json in identities/work, which holds none yet: its identity.json")]);
  });
});
