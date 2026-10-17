import type { LayoutPaths } from "../paths";
import { readUsageLog } from "../usage/read";
import type { FarmFs } from "../launcher/ports";
import type { UsageRecord } from "../usage/schema";
import { observeRecord, observationOf, type TargetObservation } from "./signals";

/** How far back a restarted door seeds its observations from the usage log, in finished records overall. */
const SEED_LOOKBACK_RECORDS = 500;

/**
 * The door's per-target observations. Every finished record folds in through `observe`; a fresh store seeds itself from the recent usage log, so a restarted door ranks a target by its recent history instead of starting blind.
 */
export interface TargetObservationStore {
  readonly observe: (record: Readonly<UsageRecord>) => void;
  /** The observation a target (`provider/model`) has earned, or undefined when nothing has been seen. */
  readonly observation: (target: string) => TargetObservation | undefined;
}

/** Builds the store over the door's filesystem, seeding from the usage log's recent records. */
export function createTargetObservationStore(fs: FarmFs, paths: LayoutPaths): TargetObservationStore {
  let observations = new Map<string, readonly UsageRecord[]>();
  const seeded = readUsageLog(fs, paths.usageLogDir, {}).records.slice(-SEED_LOOKBACK_RECORDS);
  for (const record of seeded) {
    observations = observeRecord(observations, record);
  }
  return {
    observe: (record) => {
      observations = observeRecord(observations, record);
    },
    observation: (target) => {
      const records = observations.get(target);
      return records === undefined ? undefined : observationOf(records);
    },
  };
}
