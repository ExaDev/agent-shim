/** The most a compaction may run before it is abandoned. It summarises the whole of a conversation's context, which for a large one is a long request; this bounds a request that has hung, not a slow one. In a module of its own, with no dependencies, so the front door's verbs can take the same bound without loading the compactor. */
export const COMPACT_TIMEOUT_MS = 900_000;
