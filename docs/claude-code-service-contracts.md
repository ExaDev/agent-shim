# Claude Code service contracts

What the Anthropic services that Claude Code reaches accept and answer, for the features that need a claude.ai login or a first-party endpoint. It is the reference for any agent-shim component that answers one of these services itself (the front door already answers a few), and it records the evidence for each shape so a change in the client can be told from a mistake here.

## How these contracts were established

Each section names its evidence:

- **Capture**: the traffic of a real signed-in session through the interception rig (`docs/rc-interception-rig.md`), read with `scripts/decode-http-capture.mts --contract`, which folds every sample of an endpoint into one shape. Optional keys carry a `?`, a type list means samples disagreed, and an object keyed by names collapses to `<key>`. Nothing in a shape comes from a single sample's value except an enumeration seen to vary across several.
- **Client**: the bundled client code of the Claude Code CLI, read where a feature could not be exercised on the account used (a plan the account lacks, hardware, an organisation policy, or a submission that would reach Anthropic as real data). A client contract says what the client sends and validates; it cannot say what the server does beyond that.

Shapes are of the contract the server presented to one account on one client version, so a field absent here may exist for another plan, and a field present may be absent for another. The `anthropic-beta` header values are part of each contract: a request without the named beta is a different request.

Every request below carries `authorization: Bearer <OAuth access token>` unless stated. The OAuth token's scopes decide which routes accept it: `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`, `user:plugins`, `org:create_api_key`. A route reached with a token lacking its scope is refused by the server, not by the client.

## What gates each feature

The client decides before it calls: a feature that needs a login is switched off with a logged reason, not tried and refused. The conditions, read from the client's own gate messages and confirmed by launching the CLI with debug logging under each posture:

| Posture | What the client does |
|---|---|
| OAuth login with the full scope set | everything below is reachable |
| `ANTHROPIC_AUTH_TOKEN`, an API key or `apiKeyHelper` in the environment (env-token mode) | claude.ai connectors are disabled ("API-key auth precedence active"), Claude in Chrome is disabled ("OAuth token has no scope accepted by /api/oauth/validate"), bootstrap is skipped ("no usable OAuth, WIF, or API key"), the feature-flag fetch runs on defaults, Remote Control refuses |
| `ANTHROPIC_BASE_URL` naming a host other than the Anthropic API | Remote Control and the organisation policy lookups (managed settings, the Chrome policy) are off |
| Bedrock, Vertex or Foundry | bootstrap, telemetry, the feature-flag fetch, the Files API, the connector proxy, channels, `/feedback`, cross-machine messaging, Ultrareview and cloud sessions are off |
| a plan without the feature | the server refuses: self-hosted environments need Team or Enterprise, voice and Teleport need a Claude account, channels need `channelsEnabled` from the organisation |

Per feature, the gate message the client prints and the posture it keys on:

| Feature | Gate |
|---|---|
| Remote Control | first-party API host and OAuth login ("Remote Control requires a claude.ai subscription"); refused in env-token mode |
| Cloud sessions, `--cloud` | OAuth login ("Cloud sessions require a claude.ai login"); not available on third-party providers |
| Teleport | "Teleport requires a Claude.ai account" |
| Ultrareview | "Ultrareview requires a Claude.ai account"; "unavailable on third-party providers" |
| Artifacts | "Artifacts need a claude.ai login" |
| Claude in Chrome | "Claude in Chrome requires a claude.ai subscription" and an OAuth scope the validate route accepts |
| Voice mode | "Voice mode requires a Claude.ai account", and a recorder (SoX) on the machine |
| claude.ai connectors | OAuth login with `user:mcp_servers`; disabled on third-party providers and in API-key mode |
| Files API and file upload | "unavailable on third-party providers (data-residency)"; the upload route needs `user:file_upload` |
| Channels | not available on Bedrock, Vertex, Foundry or other third-party providers; needs the organisation's `channelsEnabled` |
| `/feedback` | disabled for third-party providers, by organisation policy or by environment variable |
| Cross-machine messaging | not allowed on a third-party provider or with non-essential traffic disabled |
| Plan limits in `/usage` and the statusline | an OAuth profile scope; null for an API key, Bedrock, Vertex or a missing profile |
| Prompt-cache lifetime | one hour on a Claude subscription within its limits, five minutes on an API key, Bedrock, Vertex or Foundry |
| Managed settings and policy limits | fetched only with first-party credentials and the default base URL; `forceLoginMethod` and `forceLoginOrgUUID` in managed settings refuse a session whose login does not match |

## Account, plan and start-up

Called at start-up, in this order of dependency; every one tolerates failure by falling back to defaults, which is why a session on a non-first-party route still starts.

| Call | Beta | Answer |
|---|---|---|
| `GET /api/oauth/profile` | none | `{account{uuid, email, full_name, display_name, has_claude_max, has_claude_pro, created_at}, application{name, slug, uuid}, organization{uuid, name, organization_type, billing_type, rate_limit_tier, seat_tier, subscription_status, subscription_created_at, has_extra_usage_enabled, claude_ai_*_feedback_enabled, claude_code_trial_*, cc_onboarding_flags, payment_auth_hosted_invoice_url}, enabled_plugins[]}` |
| `GET /api/oauth/claude_cli/roles` | none | `{organization_uuid, organization_name, organization_role, workspace_uuid, workspace_name, workspace_role}`; the workspace fields are null outside a Console workspace |
| `GET /api/claude_cli/bootstrap?entrypoint&model` | `oauth-2025-04-20` | `{oauth_account{account_uuid, account_email, organization_uuid, organization_name, organization_type, organization_rate_limit_tier, seat_tier, user_rate_limit_tier}, client_data{...feature-keyed settings}, additional_model_options[{model, name, description, disabled_reason}], additional_model_costs, auto_compact_windows, hold_notice, model_access, org_model_default, cwk_cfg_key}`; the client validates it with a schema and discards the response on a parse failure |
| `GET /api/organization/claude_code_first_token_date` | `oauth-2025-04-20` | `{first_token_date}` |
| `GET /api/organizations/{org}/model_selector/cc` | none (client headers `anthropic-client-platform`, `anthropic-version`, `x-organization-uuid`) | `{model_selector_config[{id, models[{id, name, short_name, description?, section: main or overflow, quick_select?, min_claude_code_version?, capabilities{compass, gsuite_tools, mm_images, mm_pdf, web_search}, runtime{family, max_input_tokens, max_output_tokens, image_limits{max_width, max_height, max_image_tokens}, capabilities[], default_effort?, effort_levels[]}, thinking{type: effort or none, effort_options[...]}, fast_mode?{type: toggle, options[...]}, notice?}]}], provider_alias_targets{family: {default, per_provider{...}}}, settings_vocabulary{...}}` |
| `GET /api/oauth/usage` | `oauth-2025-04-20` | a record keyed by window name: `five_hour` and `seven_day` and the per-surface or per-model windows (`seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`, `seven_day_oauth_apps`, plus further windows under internal code names), each null when it does not apply to the plan or `{utilization, resets_at, limit_dollars, used_dollars, remaining_dollars, locked_reason}`; `extra_usage{is_enabled, monthly_limit, used_credits, utilization, currency, decimal_places, disabled_reason, user_disabled, spend_limit_reached, credits_ever_enabled, ...}`; a newer pair `limits[{kind: session, weekly_all or weekly_scoped, group, percent, severity, resets_at, scope?{model{display_name, id}, surface}, is_active, limit_index}]` and `spend{used, limit{amount_minor, currency, exponent}, percent, severity, enabled, disabled_reason, cap{...}}`; `member_dashboard_available`, `seven_day_breakdown{as_of, window_started_at, rows[{key: chat, claude_code, cowork or other, display_name, percent}]}` and `weekly_scoped_shares[{limit_index, used_percent_of_weekly, allowance_percent_of_weekly}]`. Query variants the client sends: none, `cedar_ember=1&skip_spend=1`, `at_wall=1&skip_spend=1`, and `starry_waterfall=<surface>&skip_spend=1` |
| `GET /api/claude_code_penguin_mode` | `oauth-2025-04-20` | `{enabled, disabled_reason}`; the fast-mode organisation status |
| `GET /api/claude_code_grove` | `oauth-2025-04-20` | `{grove_enabled, domain_excluded, grove_locked_by_claude_science, notice_is_grace_period, notice_reminder_frequency}`; the client rejects an answer whose `grove_enabled` is not a boolean |
| `GET /api/claude_code/organizations/metrics_enabled` | `oauth-2025-04-20` | `{metrics_logging_enabled}`; the client rejects an answer without a boolean there and treats the failure as "skip the export" |
| `GET /api/oauth/account/settings` | `oauth-2025-04-20` | one flat record of the account's settings by name, most null until set: onboarding and dismissal flags (`has_finished_claudeai_onboarding`, `dismissed_claudeai_banners[{banner_id, dismissed_at}]`), feature toggles (`enabled_*`, `preview_feature_uses_*`), `default_model`, `tool_search_mode`, `browser_extension_settings{enabled, default_domain_policy, allowed_domains[], blocked_domains[]}`, `enabled_mcp_tools{<connector id>:<tool name>: boolean}`, `artifact_pins_by_org{<organisation id>: boolean}`, `grove_*`, the Claude Code on the web preferences `ccr_*` (branch prefix, auto-create pull request, autofix), `internal_ccr_last_connected{<client platform>: timestamp}` and `requires_user_token` |
| `GET /api/claude_code/notification/preferences` | `oauth-2025-04-20` | `{account_id, organization_id, preferences{feature_preference{<feature>: null or {enable_push, enable_email}}}, effective_preferences{<feature>{enable_push, enable_email, push_source, email_source: always, default, explicit, inherited or unset, push_inherited_from?, email_inherited_from?}}, push_reachability{has_active_channel, most_recent_token_refresh, platforms[]}}`; written with `PATCH` on the same path |
| `GET /api/oauth/organizations/{org}/referral/eligibility?campaign` | none | `{eligible, limit, remaining_passes, referral_code_details{campaign, code, referral_link}, referrer_reward{amount_minor_units, currency}, share_link, terms_url}` |
| `GET /api/oauth/organizations/{org}/quirky-lollipop/link-offer` | none | `{status}` |
| `HEAD /api/hello` | none | 200 with no body: the reachability probe |

Evidence: capture, except that the `PATCH` of the notification preferences and the write side of the account settings are client-only (see "Client-only contracts").

### Feature flags and telemetry

- `POST /api/eval/sdk-<client key>` (beta `oauth-2025-04-20`): the feature-flag evaluation. Request `{attributes{id, deviceID, sessionId, accountUUID, organizationUUID, organizationRole, rateLimitTier, subscriptionType, subscriptionCreatedAt, firstTokenTime, userType, platform, appVersion, entrypoint: cli or sdk-cli, hasRemoteEnvironment?, hasUsedRemoteSession?, atisPin?}, forcedFeatures[], forcedVariations, url}`. Response `{features{<feature>: {defaultValue?, value?, source, experiment: null or {key, hashAttribute, variations[]}, experimentResult: null or {featureId, hashAttribute, hashUsed, hashValue, inExperiment, key, value, variationId?}}}}`, a table of several hundred features whose values are boolean, number, string or a record. A session with no usable OAuth or API key never calls it (the client logs `GrowthBook is off for this session`) and runs on defaults.
- `POST /api/event_logging/v2/batch` (beta `oauth-2025-04-20`, header `x-service-name`): `{events[{event_type, event_data{event_id, event_name, device_id, client_timestamp, auth{account_uuid, organization_uuid}, entrypoint, client_type, model, betas, session_id, env{platform, arch, version, terminal, is_ci, is_claude_ai_auth, ...}, additional_metadata, experiment_id?, experiment_metadata?, ...}}]}`; answered `200` with an acceptance record. Pure telemetry: dropping it changes nothing the user sees.
- `POST /api/claude_code/metrics` (beta `oauth-2025-04-20`): `{metrics[{name, description, unit, data_points[{value, timestamp, attributes{...}}]}], resource_attributes{service.name, service.version, os.type, os.version, host.arch, user.customer_type, user.subscription_type, aggregation.temporality}}`; answered `{accepted_count, rejected_count}`. Gated by `metrics_enabled` above.

## Cloud sessions

`claude --cloud <description>` runs a session on Anthropic's infrastructure against a GitHub repository, and `claude --teleport <id>` brings one back. Evidence: capture, from a session that ran to completion and one on a public repository, then a teleport of each.

1. **Repository lookup**: `GET /api/oauth/organizations/{org}/code/repos/{owner}/{repo}` (headers `anthropic-client-platform: claude_code_cli`, `anthropic-version: 2023-06-01`, `x-organization-uuid`). Answer `{repo{id, name, owner{id, login, type}, default_branch, description, language, visibility, private, fork, archived, disabled, size, topics[], pushed_at, github_link_optional, permissions{admin, maintain, pull, push, triage}}, status{app_installed, workflow_enabled, reason}, ghe, gitlab, source_url}`; the last three were null for github.com repositories.
2. **Environment**: `GET /v1/environment_providers?limit=100` answers `{environments[{environment_id, kind, name, description, state, config, bridge_info, owner_account_uuid, created_at}], has_more, first_id, last_id}`. The environment the CLI picks is of `kind` `anthropic_cloud`.
3. **Create**: `POST /v1/sessions` with `anthropic-beta: ccr-byoc-2025-07-29`. Request `{title, environment_id, events[{type: "event", data{type: "user", uuid, session_id: "", parent_tool_use_id: null, message{role, content}}}], session_context{model, sources[{type: "git_repository", url, revision}], outcomes[{type: "git_repository", git_info{type: "github", repo, branches[]}}], seed_bundle_file_id?}}`. The first user message is delivered with the create call. Answer `{id, title, type, origin, session_status, status_bucket, connection_status, environment_id, environment_kind, session_url, configured_model, github_access, active_mount_paths[], metadata, tags[], unread, created_at, updated_at, session_context{model, cwd, sources[...with sparse_checkout_paths and sparse_checkout_exclude_patterns], outcomes[], allowed_tools[], disallowed_tools[], builtin_tools[], environment_variables, mcp_config?{mcpServers{claude-code-remote{type: http, url, headers{X-MCP-Server-ID}, tools[{name, permission_policy}]}, github{type: http, url}}}}}`. A created session starts `pending` and was `disconnected`; both runs reached completion without the client polling.
4. **Quota and preflight**: `GET /v1/ultrareview/quota` answers `{reviews_used, reviews_limit, reviews_remaining, is_overage}`; `GET /v1/ultrareview/preflight` (also header `x-claude-code-session-id`) answers `{action, billing_note, blocked, confirm}`.
5. **Teleport**: `GET /v1/code/sessions/{id}` answers `{response_shape{...}}` wrapping the session record: `{id, title, status, status_bucket, worker_status, connection_status, environment_id, environment_kind, security_tier, session_url, tags[], unread, participants[], client_presence[], requires_action_details_list[], last_event_at, created_at, updated_at, config{model, origin, sources[], outcomes[], mcp_connector_ids[], append_system_prompt?}, post_turn_summary{title, description, is_noteworthy, needs_action, recent_action, status_category, status_detail}, external_metadata{container_cc_version, context_usage{used_tokens, max_tokens}, current_branches{<repo>: branch}, last_served_model, rate_limit_info{status, rateLimitType, resetsAt, isUsingOverage}, turn_handoff{v, worker_epoch, no_query_first, shared_message_id, staged_files, tools[]}, usage{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd}, post_turn_summary}}`. `GET /v1/code/sessions/{id}/teleport-events?limit=1000` answers `{data[{event_id, event_type: user, assistant, system or attachment, created_at, is_compaction, payload{...the transcript entry as the client stores it...}}]}`; the client replays the entries as the resumed session's history, then checks out the branch the session named (`current_branches`), and continues without the branch when the checkout fails.
6. **Files**: `POST /v1/files` (betas `files-api-2025-04-14` and `oauth-2025-04-20`, multipart) answers `{id, type: file, filename, mime_type, size_bytes, created_at, expires_at, downloadable}`: the Files API of the public SDK, used by the client to attach a repository bundle (`seed_bundle_file_id`) to a session. `GET /v1/files/{id}/content` downloads it (`--file file_id:path` at start-up).

What the capture did not exercise: the failure of a session after creation (a repository the app cannot read), a session's `status` values beyond `pending`, and `events` polling. See "Client-only contracts" for the client's reading of those.

## Remote Control and session workers

A Remote Control session registers a code session and a worker, then streams. Evidence: capture of one enabled and ended session. The shapes below match what the front door already serves (`src/frontdoor/rcSelfHostLocal.ts`); `docs/rc-agent-events.md` covers the event payloads.

| Call | Request | Answer |
|---|---|---|
| `POST /v1/code/sessions` | `{title, tags[], bridge, config{cwd, model, sources[], outcomes[], reuse_outcome_branches}}` | `{deduplicated, session{...as the teleport record above, with tags such as `remote-control-repl`}}` |
| `POST /v1/code/sessions/{id}/bridge` | none | `{api_base_url, expires_in, worker_epoch, worker_jwt}` |
| `GET /v1/code/sessions/{id}/worker` | none | `{worker{session_id, worker_epoch, worker_status, external_metadata}}` |
| `PUT /v1/code/sessions/{id}/worker` | `{worker_epoch, worker_status?: idle, running or requires_action, connection_status?, requires_action_details?, external_metadata?{model, permission_mode, context_usage, rate_limit_info, worktree_state, current_branches, artifacts[{kind, title, url, updated_at}], pending_action(s), post_turn_summary, effort_level, recap, task_summary, cross_session_inbound, is_ultracode_active}, internal_metadata?{cumulative_*_tokens, reply_degraded}}` | `200` |
| `POST .../worker/events` | `{events[{payload{...the SDK message: assistant and user messages, result, system init...}, historical?}], worker_epoch}` | `200` |
| `POST .../worker/events/delivery` | `{worker_epoch, updates[{event_id, status: received}]}` | `200`; once the session had ended, `409 {type: error, error{type: session_not_active, message}, request_id}` |
| `GET .../worker/events/stream` | header `accept: text/event-stream` | `text/event-stream` with response header `x-ccr-session-writers: v=1; owner_account_only=true`: `:keepalive` comment lines, then events `event: client_event`, `id: <sequence>`, `data: {event_id, sequence_num, event_type, source: client, payload{...}}`; the end-of-session control request arrived as `payload{type: control_request, request_id, request{subtype: end_session, reason}}` |
| `POST .../worker/heartbeat` | `{session_id, worker_epoch, idle_seconds, current_interval_seconds, supports_heartbeat_probe}` | `{heartbeat_interval_seconds}` |
| `POST .../client/presence` | `{client_id, connected_at?, clear?}` | `{refresh_after_seconds}` |
| `POST .../archive` | none | `{session{...with external_metadata}}` |

A Remote Control session id starts `cse_` and a cloud session id starts `session_`; both are served by the same `/v1/code/sessions/{id}` routes.

## Artifacts

An Artifact is a page the CLI publishes, which the claude.ai viewer serves in a sandbox. Evidence: capture of a publish, an update, an update that declared a capability, a read, a list and the live sync socket.

### Publishing

All calls carry `anthropic-beta: oauth-2025-04-20` and the client headers `x-frame-client-version`, `x-frame-platform`, `x-frame-surface`, `x-frame-session-id`, `x-frame-cp`.

- `GET /api/frame/contract/latest` answers `{version, capabilities[], core[], claude, features{mcp{host}}}`: the published contract version and the capability names it serves.
- `GET /api/frame/contract/{version}/{name}`: the page runtime's contract, served as TypeScript declarations (`artifact.d.ts`, `assets.d.ts`, `claude.d.ts`, `comments.d.ts`, `db.d.ts`, `downloads.d.ts`, `files.d.ts`, `mcp.d.ts`, `permissions.d.ts`, `room.d.ts`, `sample.d.ts`, `self.d.ts`, `user.d.ts`) and a text `prompt` that tells a model how to write a page. The declarations are the authoritative type of each capability (see "The page runtime" below); fetch them from the service rather than copying them, since they are versioned.
- `POST /api/frame/deploy/prepare` with `{entrypoint: "cli"}` answers `{slug, read, missing[]}`: a fresh slug and the URL the page will be read from.
- `POST /api/frame/deploy/direct?attempt_id=<uuid>` publishes. Request `{slug, title, description, icon, content, template, entrypoint, publish_context, request_id, baseVersion?, capabilities?{db}, contract?}`. Answer `{slug, title, version, seq, history[], read, contract, minContract, preferredContract, favicon, icon, public, owned, outside_writer, owner_account_id, owner_in_your_org, owner_workspace, typeInstance, updated_at, appliedOver?, capabilities?}`. Republishing the same slug with `baseVersion` is the update path; `appliedOver` names the version it replaced.
- `POST /api/frame/track` with `{event_name, slug, via, mode}` answers `204`; the modes seen were the auto-open outcomes.
- `GET /api/frame/read/{slug}` answers `{contract, public, owned, outside_writer, owner_account_id, owner_in_your_org}`; `GET /api/frame/{slug}?via=...` answers the record the viewer needs: the file list (`{path, contentType}`), the permissions record, an asset token and a sync token (both credentials), the capabilities and the contract version.
- `POST /api/frame/db/agent` with `{slug, verb, args{path}}`: the database access of the owner's agent (the `read_db` and `write_db` actions); the answer to the existence check was `{exists, public, owned, outside_writer, owner_account_id, owner_in_your_org}`.

### The artifacts MCP server

`POST /api/artifacts/mcp`, JSON-RPC over HTTP with headers `mcp-method`, `mcp-protocol-version` and the `x-frame-*` set. The client first sends `server/discover` (answered `404`, which it treats as "not a newer server"), then `initialize` (protocol version `2025-11-25`), then `tools/list`, then `tools/call`. The server's tools were `list_artifacts`, `list_types`, `pin_artifact`, `unpin_artifact` and `publish_version`, each with a JSON schema whose properties were `slug`, `title`, `icon`, `favicon`, `label`, `content`, `base_version`, `contract`, `deadline`, `limit`, `query`, `shared_live`, `shared_only` and `type` as relevant. `list_artifacts` returns `structuredContent{frames[{slug, title, label, rel: mine or shared, audience: owner or public, live, owner_account, owner_email, type_slug, type_title, source_surface, last_edit{chat, code, cowork}, last_viewed_at, created_at, updatedAt, icon, icon_key, tint, description, duplicable, removable, renamable}], starsEnabled, thumbsEnabled}`. A result carries `_meta["anthropic.com/artifact-route"]{status, headers{x-frame-push-remaining}}` so a publish can be rate-limited through it, and a `ttlMs` and `cacheScope` for the list. Tool calls carry `_meta["anthropic.com/artifact-route"]{request_id, attempt_id, entrypoint, publish_context, template, description}`.

### Live sync

`GET /api/frame/sync?slug=<slug>&vn=passive` upgrades to a WebSocket. The client offers `Sec-WebSocket-Protocol: frame-sync.v1,<sync token>` and `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits`; the server selects `frame-sync.v1` only and negotiates no extension, so frames are uncompressed. The sync token is the second subprotocol: dot-separated fields (the account id base64-encoded, the organisation id, the role `owner_agent`, an issue time and an expiry in epoch seconds, a signature), valid for a quarter of an hour, taken from the `GET /api/frame/{slug}` record. Every message is JSON text `{kind, slug, payload?}`:

| Direction | `kind` | `payload` |
|---|---|---|
| client to server | `activity` | `{busyS}` seconds the agent has been busy |
| client to server | `ping` | none; answered by a server message `pong` |
| server to client | `roster` | `{accountUuids[], agents[{accountUuid, busy?}]}` |
| server to client | `ctrl:joined` | `{door, lane, stores[], sendStores[]}` |
| server to client | `ctrl:invalidate` | `{tag, ver, replay?}`: the page changed; refetch |
| server to client | `pong` | none |

The server also sends WebSocket ping control frames, which the client answers with pong frames. A version string is `<epoch seconds>-<four hex digits>`, the same string the publish answer carries as `version`. On joining, the server sends one `ctrl:invalidate` with `replay: true` naming the current version, then one without `replay` for each later publish, tagged `INVALIDATE_TAG_LIVE`; `ctrl:joined` named the stores the artifact has (`bongo`, and `db` once it declared that capability). The frames a browser page exchanges (database writes, presence, comments) were not observed: a page's traffic does not pass through the rig, and the capture held a single client. Their page-visible API is the declarations above.

### The page runtime

A published page reaches the platform through `claude.use(name)`, which resolves a capability namespace or `null` (a view that cannot run it; pages are told to design for absence). The capability a page declares at publish time (`capabilities: {db: {}}` and so on) is what the server provisions. Each name has a declarations file in the contract:

| Capability | Purpose |
|---|---|
| `artifact` (formerly `self`) | the page's own record: publish a new version of itself, edit a live doc, read metadata |
| `assets` | upload, list and delete binary and text assets with durable ids |
| `comments` | write comment threads on the artifact as the viewer |
| `db` | a persistent realtime document store shared by viewers: slash-separated paths, live subscriptions, access rules keyed on the viewer's sharing level (`view`, `interact`, `admin`, `owner`) |
| `downloads` | offer a generated file to the viewer behind a confirmation |
| `files` | read the files of a Claude Code project the artifact declares, with the viewer's own access |
| `mcp` | call the viewer's connected MCP tools (`callTool`, `watchTool`, `listTools`, `server(name)`) with the viewer's credentials |
| `permissions` | read and request the page's capability permissions (`state`, `request`, `manage`) |
| `room` | everyone viewing now: `emit` and `on` for transient topics, `presence` for shared per-viewer state, and sending a message to the viewer's Claude session |
| `sample` | ask Claude from the page on the viewer's own account (`sample`, `sample.json`, `limits`) |
| `user` | facts about the viewer and the people the shared state refers to |

The page host is a sandboxed origin of the artifact service, not `api.anthropic.com`; a read from the CLI of a published page's content goes there.

## Files and attachments

- `POST /api/oauth/file_upload` (multipart, header `x-claude-code-upload-lane`) answers `201 {uuid, file_uuid, file_name, sanitized_name, file_kind, media_type, size_bytes, path, user_uuid, created_at, success}`. It is how the `SendUserFile` tool delivers a file from a Remote Control session to the user's devices. Evidence: capture.
- The Files API of the public SDK (`/v1/files`, `/v1/files/{id}/content`) is described under Cloud sessions.

## Connectors, plugins and skills

- `GET /v1/mcp_servers?limit&include_additional_installs` (betas `mcp-servers-2025-12-04`; headers `anthropic-mcp-client-capabilities`, `mcp-protocol-version`) lists the claude.ai connectors: `{data[{id, type, display_name, url, label, icon_url, eligible, eligibility_reason: connected, never_connected_no_auto_connect or not_an_org_connector, enterprise_managed, additional_install, default_max_permission, stateless, discover_support, cached_init_response{protocolVersion, capabilities, serverInfo}, cached_discover_response, tools[{name, effective_max_permission}], created_at}], next_page}`. The client turns each entry into an HTTP MCP server routed through the Anthropic MCP proxy. They are disabled when the session is on API-key or token authentication, a non-first-party provider, or safe mode.
- `GET /mcp-registry/v0/servers?version=latest&limit&visibility&cursor` answers the connector directory, paged by `metadata.nextCursor`: `{servers[{server{name, title, description, version, websiteUrl, icons[], remotes[{type: sse or streamable-http, url}], packages[...], repository}, _meta{"io.modelcontextprotocol.registry/official"{status, isLatest, publishedAt, updatedAt}, "com.anthropic.api/mcp-registry"{...display and listing fields: slug, displayName, oneLiner, iconUrl, visibility[], worksWith[], toolNames[], promptNames[], requiredFields[{field, sourceUrl}], source: auto-sync or manual...}}}], metadata{count, nextCursor?}}`. Unauthenticated.
- `GET /api/directory/plugins?limit&visibility&include&page` answers the public plugin directory, paged: `{data[{id, name, manifest_name, added_time, license, links{homepage, documentation, privacy_policy, support, terms_of_service}, media{icons[], screenshots[], videos[]}, compatibility[{surface: claude_ai, claude_code, claude_desktop or cowork, state: works, partly, does_not_work or unknown, component_types[]}], components[{key, name, type: agent, cli, command, hook, mcp_server or skill, description, slash_command, access{type: runs_on_your_computer, sends_data_to or stays_inside_claude, service, passes_on}, checks}], checks{review{state, by{type}}, scan{state}}, installation{state, actions{sign_in}}, launch?{...}}], next page token}`.
- Organisation plugins: `GET /api/oauth/organizations/{org}/marketplaces` (answers `{marketplaces[{id, name, display_name, description, scope, is_org_native, source{source, repo, last_synced_sha}, updated_at}]}`, honours `if-none-match` with `304`), `GET .../plugins/list-plugins?enabled_only&compact&limit&offset` (`{plugins[...a record of manifest fields, components[], classification{...}, enabled, marketplace_*...], has_more, next_page, degraded}`), `GET .../plugins/{plugin_id}/download` (binary archive).
- Organisation skills: `GET .../skills/list-skills?entrypoint&include_wiggle_skills` (`{skills[{id, name, display_name, description, enabled, enable_count, source: anthropic or anthropic-example, creator_type, partition_by: account or workspace, is_shared, hooks, created_at, updated_at, ...}]}`) and `GET .../skills/{name}/download?entrypoint` (binary archive).

Evidence: capture.

## Client-only contracts

The sections that follow come from the client code, because the capture could not exercise them. They say what the client builds and validates.

### Self-hosted runner

The runner is part of the CLI (`claude self-hosted-runner --api-url <url> --environment-secret-file <path>`), so its whole contract can be exercised against a stand-in server with no Anthropic account; this section is the client's reading of it, confirmed by running the runner against such a stand-in. The server side also requires a Team or Enterprise plan with self-hosted environments allowed for the organisation.

Every runner call carries `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01` and `x-self-hosted-runner-version`. The bearer is the environment secret for `register`, the runner token for the runner routes and the session token for the session routes. Every id in a path, and every id in an answer, must match `^[a-zA-Z0-9_-]+$` and be at most 256 characters.

| Call | Request | Answer the client reads |
|---|---|---|
| `POST /v1/code/runners/self-hosted/runners/register` | `{runner_version, use_anthropic_git_proxy, server_auto_mode_lists: SERVER_AUTO_MODE_LISTS_NO_ALLOW or SERVER_AUTO_MODE_LISTS_NONE, client_label, lock_to_account_id?}` | `{runner_id, runner_token}` |
| `POST .../runners/{runner_id}/poll` | `{available_capacity, wake_source?, warmup_complete?}` | `{assignment_ids[], session_assignments[], lease_expires_at, suggested_poll_interval}` |
| `POST .../sessions/{id}/token` | `{}` | `{session_token, tools_host?}` |
| `GET /v1/code/sessions/{id}/remote` | none | `{sources, push_targets, claude_code_args, environment_variables}`, each defaulting to empty |
| `POST .../sessions/{id}/report-failure` | `{reason, kind or setup_failure_kind, excluded_count?}` | the client reads `stuck` and `excluded_count` |
| `POST .../sessions/{id}/release` | `{}` | the client reads `released` |
| `POST .../deregister` | `{reason, drain_hold, outcome, held_ms, busy_session_ids_at_release}` | none read |
| `POST /v1/code/auth/refresh` | none | `{token}` |

`poll` answers: `assignment_ids` must be an array of valid ids or the whole response is rejected as malformed; `session_assignments` is read only as an array of `{session_id, client_platform?}` where an item without a non-empty string `session_id` is skipped and a `client_platform` matching `^[A-Za-z0-9_.-]{1,64}$` labels the session in the runner's metrics (any other value is logged once and the label falls back to `unknown`); `lease_expires_at` and `suggested_poll_interval` are kept only when strings. Three consecutive `404` answers make the runner drain and exit as "runner record gone server-side".

`tools_host`, when present, must decode as `{tool_server_hosting: integer of at least 1 (a digit string is converted), api_base_url: non-empty string, cwd?: string or null}`; one that fails the schema fails the call with "response holds a tools_host that this runner cannot read". Absent or null, only the session token is returned.

After the token and the remote configuration, the runner clones the sources, starts a child session, and the child speaks the worker family of "Remote Control and session workers" above (`worker/register` answering `worker_epoch`, events, `PUT worker`, heartbeat, diagnostics). The orchestrator variant adds `spawn-hints/poll` and `spawn-hints/nack`, and `--teleport` lists environments through `pools`.

<!-- client-only sections are appended below from the client reading -->
