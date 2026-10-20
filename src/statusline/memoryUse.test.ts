import { describe, expect, it } from "vitest";

import { formatBytes, memoryUseFromMeminfo, usedBytesFromVmStat } from "./memoryUse";

const KIBIBYTE = 1024;
const GIBIBYTE = KIBIBYTE * KIBIBYTE * KIBIBYTE;
const TEBIBYTE = GIBIBYTE * KIBIBYTE;
const SEVEN_AND_A_BIT_GIB = 7.6;
const SIXTEEN_GIB = 16;
const BEYOND_THE_LARGEST_UNIT = 2048;
const PAGE_SIZE = 16_384;
const ACTIVE_PAGES = 100_000;
const WIRED_PAGES = 50_000;
const COMPRESSOR_PAGES = 20_000;
const TOTAL_KIBIBYTES = 16_000_000;
const AVAILABLE_KIBIBYTES = 4_000_000;
const VM_STAT = [
  `Mach Virtual Memory Statistics: (page size of ${String(PAGE_SIZE)} bytes)`,
  "Pages free:                               12345.",
  `Pages active:                            ${String(ACTIVE_PAGES)}.`,
  "Pages inactive:                           90000.",
  `Pages wired down:                         ${String(WIRED_PAGES)}.`,
  `Pages occupied by compressor:             ${String(COMPRESSOR_PAGES)}.`,
].join("\n");

/** Sizes and how they are written: below a unit, a decimal place below ten units, none from ten up. */
const SIZES: readonly (readonly [number, string])[] = [
  [0, "0 B"],
  [KIBIBYTE / 2, "512 B"],
  [KIBIBYTE + KIBIBYTE / 2, "1.5 KB"],
  [GIBIBYTE * SEVEN_AND_A_BIT_GIB, "7.6 GB"],
  [GIBIBYTE * SIXTEEN_GIB, "16 GB"],
  [TEBIBYTE * 2, "2.0 TB"],
  [TEBIBYTE * BEYOND_THE_LARGEST_UNIT, "2048 TB"],
];

describe("formatBytes", () => {
  it("writes a size in the largest unit that keeps it at or above one, with a decimal place only below ten", () => {
    for (const [bytes, text] of SIZES) {
      expect(formatBytes(bytes)).toBe(text);
    }
  });
});

describe("usedBytesFromVmStat", () => {
  it("counts active, wired and compressor-occupied pages, the memory that cannot be handed on without cost", () => {
    expect(usedBytesFromVmStat(VM_STAT)).toBe((ACTIVE_PAGES + WIRED_PAGES + COMPRESSOR_PAGES) * PAGE_SIZE);
  });

  it("is undefined when the page size or a count is missing", () => {
    expect(usedBytesFromVmStat("Pages active: 1.\nPages wired down: 1.")).toBeUndefined();
    expect(usedBytesFromVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 1.")).toBeUndefined();
    expect(usedBytesFromVmStat(VM_STAT.replace(/Pages occupied by compressor.*/, ""))).toBeUndefined();
  });
});

describe("memoryUseFromMeminfo", () => {
  it("takes what the kernel reports as not available as in use", () => {
    const text = `MemTotal:       ${String(TOTAL_KIBIBYTES)} kB\nMemFree: 1 kB\nMemAvailable:    ${String(AVAILABLE_KIBIBYTES)} kB\n`;
    expect(memoryUseFromMeminfo(text)).toEqual({ totalBytes: TOTAL_KIBIBYTES * KIBIBYTE, usedBytes: (TOTAL_KIBIBYTES - AVAILABLE_KIBIBYTES) * KIBIBYTE });
  });

  it("is undefined when either figure is missing", () => {
    expect(memoryUseFromMeminfo("MemTotal: 16000000 kB\n")).toBeUndefined();
    expect(memoryUseFromMeminfo("MemAvailable: 4000000 kB\n")).toBeUndefined();
  });
});
