import { describe, expect, it } from "vitest";

import { createLogPort, type LogSinks, type StyleText } from "./logStyle";

/** A style that shows what it was asked for, so a test reads the formatting without escape codes. */
const visible: StyleText = (formats, text) => `<${formats.join("+")}>${text}</>`;
const plain: StyleText = (_formats, text) => text;

/** A log port over sinks that record what they are given, by channel. */
function setup(style: StyleText) {
  const out: string[] = [];
  const warn: string[] = [];
  const err: string[] = [];
  const sinks: LogSinks = {
    out: (line) => {
      out.push(line);
    },
    warn: (line) => {
      warn.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  };
  return { port: createLogPort(sinks, { out: style, err: style }), out, warn, err };
}

describe("createLogPort", () => {
  it("dims information and sends it to the output channel", () => {
    const { port, out } = setup(visible);

    port.info("agent-shim: identity work");

    expect(out).toEqual(["<dim>agent-shim: identity work</>"]);
  });

  it("colours a warning yellow with its code in bold, and sends it to the warning channel", () => {
    const { port, warn } = setup(visible);

    port.warn("agent-shim: UNCLASSIFIED_ENTRY: 2 entries are not in the map");

    expect(warn).toEqual(["<yellow>agent-shim: </><yellow+bold>UNCLASSIFIED_ENTRY</><yellow>: 2 entries are not in the map</>"]);
  });

  it("colours an error red the same way, and sends it to the error channel", () => {
    const { port, err } = setup(visible);

    port.error("agent-shim: FARM_FAILED: could not swap");

    expect(err).toEqual(["<red>agent-shim: </><red+bold>FARM_FAILED</><red>: could not swap</>"]);
  });

  it("colours every line of a multi-line warning, with the code in bold on the first only", () => {
    const { port, warn } = setup(visible);

    port.warn("agent-shim: UNCLASSIFIED_ENTRY: 2 entries are excluded\n  Run the fix");

    expect(warn).toEqual(["<yellow>agent-shim: </><yellow+bold>UNCLASSIFIED_ENTRY</><yellow>: 2 entries are excluded</>\n<yellow>  Run the fix</>"]);
  });

  it("prints a launch report as lines on the output channel, styled by the report's own rules", () => {
    const { port, out } = setup(visible);

    port.report([{ label: "identity", value: "work", detail: "argv" }]);

    expect(out).toEqual(["<bold>agent-shim</>", "  <dim>identity</>  work <dim>(argv)</>"]);
  });

  it("colours a line with no code whole", () => {
    const { port, warn, err } = setup(visible);

    port.warn("agent-shim: pool work has nothing to compact");
    port.error("something else failed");

    expect(warn).toEqual(["<yellow>agent-shim: pool work has nothing to compact</>"]);
    expect(err).toEqual(["<red>something else failed</>"]);
  });

  it("writes exactly the text it was given when the style adds nothing", () => {
    const { port, out, warn, err } = setup(plain);

    port.info("agent-shim: a");
    port.warn("agent-shim: CODE: b");
    port.error("agent-shim: CODE: c");

    expect([out, warn, err]).toEqual([["agent-shim: a"], ["agent-shim: CODE: b"], ["agent-shim: CODE: c"]]);
  });
});
