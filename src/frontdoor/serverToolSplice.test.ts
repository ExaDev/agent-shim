import { describe, expect, it } from "vitest";

import { applyingEdits, choiceNamesRemovedTool, planningToolRemoval } from "./serverToolSplice";
import { walkTopLevelMembers } from "./topLevelMembers";

function planned(body: string): ReturnType<typeof planningToolRemoval> {
  const members = walkTopLevelMembers(body);
  if (members === undefined) {
    throw new Error("the fixture is not a JSON object");
  }
  return planningToolRemoval(body, members);
}

describe("naming the tools a removal drops", () => {
  it("names a tool by its name, else its type, else as unnamed", () => {
    const removal = planned('{"tools":[{"name":"web_search","type":"web_search_20250305"},{"type":"computer_20250124"},{}]}');
    expect(removal.kind === "planned" && removal.dropped).toEqual(["web_search", "computer_20250124", "unnamed"]);
  });

  it("labels a tool whose name or type is not a string by the other, and else as unnamed, never by a value that is no text", () => {
    const removal = planned('{"tools":[{"name":5,"type":"computer_20250124"},{"name":"web_search","type":5},{"name":5,"type":7},{"name":null,"type":null}]}');
    expect(removal.kind === "planned" && removal.dropped).toEqual(["computer_20250124", "web_search", "unnamed", "unnamed"]);
  });

  it("is not thrown by a tools entry that is no object, which stays in the body and is never named", () => {
    const removal = planned('{"tools":[null,{"type":"web_search_20250305"},1,"x",[]]}');
    expect(removal.kind === "planned" && removal.dropped).toEqual(["web_search_20250305"]);
  });
});

describe("a tool_choice that names a tool two tools share the name of", () => {
  it("goes when every tool of that name is removed, and stays when one of them is kept", () => {
    const choice = '"tool_choice":{"type":"tool","name":"a"}';
    const keptToo = planned(`{"tools":[{"name":"a","input_schema":{}},{"name":"a","type":"web"}],${choice}}`);
    expect(keptToo.kind === "planned" && keptToo.edits.length).toBe(1);
    const allRemoved = planned(`{"tools":[{"name":"a","type":"x"},{"name":"a","type":"web"},{"name":"b","input_schema":{}}],${choice}}`);
    expect(allRemoved.kind === "planned" && allRemoved.edits.length).toBe(2);
  });
});

/** The body after the removal `body` plans is applied, or the body itself when none is planned. */
function afterRemoval(body: string): string {
  const removal = planned(body);
  return removal.kind === "planned" ? applyingEdits(Buffer.from(body, "latin1"), removal.edits).toString("latin1") : body;
}

describe("a tool_choice when the tools it could name are removed or absent", () => {
  it.each(['{"type":"auto"}', '{"type":"any"}', '{"type":"tool","name":"kept-name"}'])("goes with %s when every tool goes", (choice) => {
    expect(afterRemoval(`{"model":"m","tools":[{"type":"web_search_20250305"}],"tool_choice":${choice}}`)).toBe('{"model":"m"}');
  });

  it("stays when it names a tool that is in no tools array, and a tool is removed", () => {
    expect(afterRemoval('{"tools":[{"name":"a","input_schema":{}},{"type":"web_search_20250305"}],"tool_choice":{"type":"tool","name":"absent"}}')).toBe('{"tools":[{"name":"a","input_schema":{}}],"tool_choice":{"type":"tool","name":"absent"}}');
  });

  it("stays when it names no tool and a tool is kept", () => {
    expect(afterRemoval('{"tools":[{"name":"a","input_schema":{}},{"type":"web_search_20250305"}],"tool_choice":{"type":"auto"}}')).toBe('{"tools":[{"name":"a","input_schema":{}}],"tool_choice":{"type":"auto"}}');
  });
});

/** A set of removed positions that counts the work done on it: lookups, and any walk over its members. */
class CountingSet extends Set<number> {
  lookups = 0;
  walks = 0;

  override has(value: number): boolean {
    this.lookups += 1;
    return super.has(value);
  }

  override [Symbol.iterator](): SetIterator<number> {
    this.walks += 1;
    return super[Symbol.iterator]();
  }
}

/** `labels` wrapped so each element read or presence check made on it calls `onRead`: the work done on the labels of the tools. */
function countingReads(labels: readonly string[], onRead: () => void): readonly string[] {
  const isIndex = (key: string | symbol): boolean => typeof key === "string" && /^\d+$/u.test(key);
  return new Proxy(labels, {
    get: (target, key, receiver) => {
      if (isIndex(key)) {
        onRead();
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
    has: (target, key) => {
      if (isIndex(key)) {
        onRead();
      }
      return Reflect.has(target, key);
    },
  });
}

/** What one pass over the labels costs a callback-driven walk such as `forEach`: a presence check and a read for each element. */
const READS_PER_ELEMENT = 2;

describe("the work of deciding whether a tool_choice names a removed tool", () => {
  const SMALL = 1000;
  const SIZES = [SMALL, SMALL * 2, SMALL * 2 * 2];

  /** The work for `size` tools that all carry the name asked for, all removed but the last: lookups of the removed set, walks over it, and element reads of the labels. */
  function workFor(size: number): { readonly lookups: number; readonly walks: number; readonly reads: number } {
    let reads = 0;
    const labels = countingReads(Array.from({ length: size }, () => "shared"), () => {
      reads += 1;
    });
    const removed = new CountingSet();
    for (let index = 0; index < size - 1; index += 1) {
      removed.add(index);
    }
    expect(choiceNamesRemovedTool({ type: "tool", name: "shared" }, labels, removed)).toBe(false);
    return { lookups: removed.lookups, walks: removed.walks, reads };
  }

  it.each(SIZES)("makes at most one lookup for each of %i tools, reads each label a constant number of times and never walks the removed positions", (size) => {
    const work = workFor(size);
    expect(work.lookups).toBeLessThanOrEqual(size);
    expect(work.reads).toBeLessThanOrEqual(READS_PER_ELEMENT * size);
    expect(work.walks).toBe(0);
  });

  it("grows by no more than the number of tools when the tools double", () => {
    const small = workFor(SIZES[0] ?? 0);
    const large = workFor(SIZES[1] ?? 0);
    expect(large.lookups).toBeLessThanOrEqual(small.lookups * 2 + 1);
    expect(large.reads).toBeLessThanOrEqual(small.reads * 2 + 1);
  });
});

describe("which tools a removal takes", () => {
  it("takes only objects with no input_schema: an array element is no tool of either kind and is left alone", () => {
    expect(planned('{"tools":[["x"],{"name":"a","input_schema":{}}]}')).toEqual({ kind: "unchanged" });
    const removal = planned('{"tools":[["x"],{"type":"web_search_20250305"}]}');
    expect(removal.kind === "planned" && removal.dropped).toEqual(["web_search_20250305"]);
  });
});

describe("the bytes a removal leaves", () => {
  const server = '{"type":"web_search_20250305"}';
  const kept = '{"name":"k","input_schema":{}}';
  it.each([
    ["a removed run followed by a kept tool", `{"tools":[${server}, ${server},${kept}]}`, `{"tools":[${kept}]}`],
    ["a removed tool in the middle of kept ones", `{"tools":[${kept},${server},${kept}]}`, `{"tools":[${kept},${kept}]}`],
    ["a removed run that ends the list, with whitespace before its comma", `{"tools":[${kept}  ,  ${server},${server}]}`, `{"tools":[${kept}  ]}`],
    ["a removed tool that ends the list, spaced and newlined (the whitespace around the comma stays)", `{"tools":[${kept}\n,\n${server}\n]}`, `{"tools":[${kept}\n\n]}`],
    ["a removed first tool followed by whitespace", `{"tools":[${server} ,\n  ${kept}]}`, `{"tools":[${kept}]}`],
  ])("is the kept bytes alone for %s", (_label, body, expected) => {
    expect(afterRemoval(body)).toBe(expected);
  });
});

describe("a body that names tools or tool_choice twice", () => {
  it.each([
    ["tools", '{"tools":[],"tools":[]}'],
    ["tool_choice", '{"tool_choice":{},"tool_choice":{}}'],
  ])("is ambiguous in %s with exactly two members, and not with one", (key, twice) => {
    expect(planned(twice)).toEqual({ kind: "ambiguous", key });
    expect(planned(`{"${key}":[]}`).kind).not.toBe("ambiguous");
  });

  it("is ambiguous with three members of one name as well", () => {
    expect(planned('{"tools":[],"tools":[],"tools":[]}')).toEqual({ kind: "ambiguous", key: "tools" });
  });
});

describe("edits that touch", () => {
  it("are applied whole when one ends where the next begins, and refused only when they overlap", () => {
    const body = Buffer.from("abcdef");
    expect(applyingEdits(body, [{ start: 0, end: 2 }, { start: 2, end: 4, replacement: Buffer.from("X") }]).toString()).toBe("Xef");
    expect(() => applyingEdits(body, [{ start: 0, end: 3 }, { start: 2, end: 4 }])).toThrow(RangeError);
  });
});

describe("a body whose members come in any order", () => {
  const server = '{"type":"web_search_20250305"}';
  const kept = '{"name":"k","input_schema":{}}';
  it.each([
    ["tool_choice before tools", `{"tool_choice":{"type":"tool","name":"k"},"tools":[${kept},${server}],"model":"m"}`, `{"tool_choice":{"type":"tool","name":"k"},"tools":[${kept}],"model":"m"}`],
    ["tool_choice naming the removed tool, before tools", `{"tool_choice":{"type":"tool","name":"web"},"tools":[${kept},{"name":"web","type":"web_search_20250305"}],"model":"m"}`, `{"tools":[${kept}],"model":"m"}`],
    ["tools last, with every tool removed", `{"model":"m","tool_choice":{"type":"auto"},"tools":[${server}]}`, '{"model":"m"}'],
    ["tools between kept members", `{"a":1,"tools":[${server},${kept}],"b":2}`, `{"a":1,"tools":[${kept}],"b":2}`],
  ])("removes exactly the dropped spans and leaves valid JSON: %s", (_label, body, expected) => {
    const after = afterRemoval(body);
    expect(after).toBe(expected);
    expect(() => {
      JSON.parse(after);
    }).not.toThrow();
  });

  it("leaves a tools member that holds a string, whatever the string spells", () => {
    expect(planned('{"tools":"{}, {}","model":"m"}')).toEqual({ kind: "unchanged" });
  });
});
