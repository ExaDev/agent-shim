import type { STATUSLINE_HEADER_SEGMENTS, STATUSLINE_ROWS } from "../../config/statusline";
import type { ColourRole } from "../palette";
import type { RenderContext, RowOutput } from "./context";
import { accountSegment } from "./header/account";
import { advisorSegment } from "./header/advisor";
import { effortSegment } from "./header/effort";
import { costSegment, dailyCostSegment } from "./header/cost";
import { headroomSegment } from "./header/headroom";
import { identitySegment } from "./header/identity";
import { modelSegment } from "./header/model";
import { outputStyleSegment } from "./header/outputStyle";
import { projectSegment } from "./header/project";
import { providerSegment } from "./header/provider";
import { routeSegment } from "./header/route";
import { versionSegment } from "./header/version";
import { vcsSegment } from "./header/vcs";
import { addedDirsRow } from "./rows/addedDirs";
import { contextRow } from "./rows/context";
import { gitFilesRow } from "./rows/gitFiles";
import { environmentRow } from "./rows/environment";
import { memoryRow } from "./rows/memory";
import { quotaRow } from "./rows/quota";

/** How one element draws itself. */
export interface ElementRegistry {
  /** The text of each header segment, or undefined when it has nothing to show. */
  readonly header: Readonly<Record<(typeof STATUSLINE_HEADER_SEGMENTS)[number], (context: RenderContext) => string | undefined>>;
  readonly rows: Readonly<Record<(typeof STATUSLINE_ROWS)[number], (context: RenderContext) => RowOutput>>;
}

/** The colour role each header segment is painted in. */
export const HEADER_ROLES: Readonly<Record<(typeof STATUSLINE_HEADER_SEGMENTS)[number], ColourRole>> = {
  model: "model",
  provider: "model",
  route: "label",
  account: "label",
  identity: "label",
  headroom: "label",
  project: "project",
  vcs: "git",
  effort: "model",
  advisor: "label",
  version: "label",
  outputStyle: "label",
  cost: "label",
  dailyCost: "label",
};

/** Every element the built-in statusline can draw. A setting can only name an element listed here, and the schema's lists of names are what keep the two in step. */
export const ELEMENTS: ElementRegistry = {
  header: { model: modelSegment, provider: providerSegment, route: routeSegment, account: accountSegment, identity: identitySegment, headroom: headroomSegment, project: projectSegment, vcs: vcsSegment, effort: effortSegment, advisor: advisorSegment, version: versionSegment, outputStyle: outputStyleSegment, cost: costSegment, dailyCost: dailyCostSegment },
  rows: { context: contextRow, quota: quotaRow, addedDirs: addedDirsRow, gitFiles: gitFilesRow, memory: memoryRow, environment: environmentRow },
};
