import type { BarCell } from "../../barGrid";
import { formatBytes } from "../../memoryUse";
import { writtenPercent } from "../../percent";
import { barCell, FULL_PERCENT, statusColor, withColor } from "../../style";
import { barStyleOf, type RenderContext, type RowOutput } from "../context";

/** The machine's memory in use, as a bar with the figures beside it. The figure is approximate (it is the operating system's account of memory it cannot hand out without cost, not any process's own), and the bar is coloured as the quota bars are, by the usage roles at the bands and under the same `bar.gradient`; nothing is drawn when the platform gives no figure. */
export function memoryRow(context: RenderContext): RowOutput {
  const use = context.ports.memoryUse();
  const cells: BarCell[] = [];
  if (use !== undefined && use.totalBytes > 0) {
    const style = barStyleOf(context, "usage");
    const fraction = Math.max(0, Math.min(1, use.usedBytes / use.totalBytes));
    const percent = withColor(statusColor(fraction, true, style), `${writtenPercent(fraction * FULL_PERCENT)}%`);
    cells.push(barCell(context.palette.paint("label", `${context.t("memory.label")} `), ` ${percent} (${formatBytes(use.usedBytes)} / ${formatBytes(use.totalBytes)})`, fraction, style));
  }
  return { kind: "bars", cells };
}
