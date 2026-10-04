# Measuring headroom

Headroom compresses requests before they reach the provider. Whether that is worth its cost depends on three things its own statistics do not combine: how many tokens each transform removes, whether it keeps the earlier turns of a conversation byte-for-byte unchanged so the provider's prefix cache still hits, and how long it adds to every request. `scripts/headroom-measure.mts` measures all three on real conversations, offline, for every setting the `headroom` config block can express.

Results are point-in-time (they depend on the installed headroom build, the workload and the machine), so they are recorded on the tracking issue and not here. This page describes the method and its limits.

## Running it

```bash
node scripts/headroom-measure.mts --sessions 6 --requests 25 --out ./results
node scripts/headroom-measure.mts --dry-run                       # print the workload shape and stop
node scripts/headroom-measure.mts --variants "cache (default),token"
node scripts/headroom-measure.mts --transcript ./session.jsonl    # replay a chosen transcript (repeatable)
```

`--projects-dir` (repeatable) names where to look for transcripts, `~/.claude/projects` by default; add an identity's own `projects` directory to include sessions kept outside the shared history. Without `--transcript`, the largest transcript of each project is used, up to `--sessions`, and the last `--requests` consecutive requests of each conversation are replayed. The headroom binary is the one `uv tool install` put under `~/.local/share/uv/tools/headroom-ai`.

## How it works

**The workload** is rebuilt from the transcripts. The main conversation (the parent chain from the last entry, which drops abandoned branches and sidechains) becomes alternating Messages-API messages: the per-block lines Claude Code writes are merged, thinking blocks and images are dropped, and a tool result keeps only its text items (a `tool_reference` item names a deferred tool the placeholder tool block cannot define, which headroom would repair in a way a live request never needs). A request is made after every user-side message, and each request begins with exactly the messages of the one before, so replaying them in order gives headroom the same growing prefix a live session does.

**Each variant gets its own scratch daemon**, started with the arguments and environment `src/headroom/settings.ts` produces for that settings object, so a variant is exactly what the matching `headroom` config block would run. The daemon is offline (`HEADROOM_OFFLINE=1`, `HF_HUB_OFFLINE=1`), stateless, without telemetry, in a throwaway workspace and with an environment that carries none of this process's credentials. It forwards only to a loopback fake upstream that answers every request with a canned reply, so nothing about your conversations leaves the machine and no provider is called. Its local rate limiter is off for the replay, since a measurement must not be throttled.

**Each request is scored** from headroom's own response headers (`x-headroom-tokens-before`, `-after` and `-transforms`) and from the body the fake upstream actually received:

- *Prefix preserved:* the request is split into the segments a provider cache hashes in order (tools, system, then each message), and the leading segments identical to the previous request's are counted. `cache_control` placement and key order are ignored, because a breakpoint moves every turn and does not change what a cache matches on.
- *Added latency:* the same body is also sent straight to the fake upstream, and the difference is the cost of headroom being in the path.

## The cost model

An input token served from the provider's prefix cache costs a fraction of an uncached one, so tokens removed is the wrong figure on its own: compression that rewrites earlier turns can lose more than it saves. Each request is priced as its reused-prefix tokens at the cache-read multiplier plus everything else at the cache-write multiplier, in units of the base input price, and every variant is compared with the same requests sent unmodified (where the previous request is the prefix and the newest messages are written fresh).

The multipliers are the documented ones (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, Pricing): a 5-minute cache write costs 1.25 times the base input price and a cache read 0.1 times it, except that some models differ (Opus 5.5 reads at 0.05 times). Both the default and the Opus figure are reported, since the lower the read price, the more a lost prefix costs.

## Variants

The matrix covers `cache` (headroom's default) and `token` modes, lower `--target-ratio` values, `--lossless` and `--no-ccr` (retrieval markers off), and the experimental `--intercept-tool-results` and `--read-maturation` behind their rollout channels. `--variants` selects by name.

## Limits

- **The system prompt and tools are placeholders.** The transcripts do not contain them, so every request carries a fixed block of realistic size. They are the stable head of the prefix and no transform here is expected to change them; a real request's head is not identical.
- **No real provider cache is exercised.** Prefix preservation is the necessary condition for a cache hit, not a hit rate. The cost model assumes every preserved prefix is read from cache, ignores the cache's time to live (a replay has no gaps between turns) and prices input only.
- **Latency is measured on the machine as it is.** Compression is CPU-bound, so contention from other work inflates it; treat the figure as an upper bound and record the load beside it.
- **The workload is one person's sessions.** Conversations dominated by a different kind of tool output will compress differently.
- **Replayed content is not recorded.** The per-request records written to `--out` carry token counts, transform names, byte counts and timings, and sessions are named `s1`, `s2` and so on, never by transcript path.
