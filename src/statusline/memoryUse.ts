/** How much of the machine's memory is in use, in bytes. */
export interface MemoryUse {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

const BYTES_PER_KIBIBYTE = 1024;

/** The units a byte count is written in below the largest, each `BYTES_PER_KIBIBYTE` times the one before, and the largest, which a bigger count is still written in. */
const SMALLER_UNITS = ["B", "KB", "MB", "GB"] as const;
const LARGEST_UNIT = "TB";

/** A byte count in the largest unit that keeps it at or above one, with one decimal place below ten units and none from ten up (`512 MB`, `7.6 GB`, `16 GB`): the figure is an approximation, so more digits would only suggest precision it lacks. */
export function formatBytes(bytes: number): string {
  const firstWholeDigits = 10;
  let value = Math.max(0, bytes);
  for (const unit of SMALLER_UNITS) {
    if (value < BYTES_PER_KIBIBYTE) {
      return `${value.toFixed(value >= firstWholeDigits || unit === "B" ? 0 : 1)} ${unit}`;
    }
    value /= BYTES_PER_KIBIBYTE;
  }
  return `${value.toFixed(value >= firstWholeDigits ? 0 : 1)} ${LARGEST_UNIT}`;
}

/** The bytes in use on macOS, from `vm_stat`'s page counts: active and wired pages and the pages the compressor occupies are the memory that cannot be handed on without cost (compressed pages hold real RAM), while inactive, speculative and cached pages are free for the next program to take. Undefined when the output lacks the page size or any count. */
export function usedBytesFromVmStat(output: string): number | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const active = /Pages active:\s+(\d+)/.exec(output)?.[1];
  const wired = /Pages wired down:\s+(\d+)/.exec(output)?.[1];
  const compressed = /Pages occupied by compressor:\s+(\d+)/.exec(output)?.[1];
  if (pageSize === undefined || active === undefined || wired === undefined || compressed === undefined) {
    return undefined;
  }
  return (Number(active) + Number(wired) + Number(compressed)) * Number(pageSize);
}

/** The memory use on Linux, from `/proc/meminfo`: what the kernel reports as not available (free plus reclaimable cache) is in use. Undefined when the text lacks either figure. */
export function memoryUseFromMeminfo(text: string): MemoryUse | undefined {
  const totalKibibytes = /^MemTotal:\s+(\d+)\s+kB/m.exec(text)?.[1];
  const availableKibibytes = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text)?.[1];
  if (totalKibibytes === undefined || availableKibibytes === undefined) {
    return undefined;
  }
  const totalBytes = Number(totalKibibytes) * BYTES_PER_KIBIBYTE;
  return { totalBytes, usedBytes: totalBytes - Number(availableKibibytes) * BYTES_PER_KIBIBYTE };
}
