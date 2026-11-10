import { defineConfig } from "eslint/config";
import globals from "globals";
import exadev from "@exadev/eslint-config";
import { dialPlugin } from "./eslint-rules/dial";

export default defineConfig([
  { ignores: ["dist", "coverage", "node_modules"] },
  {
    languageOptions: {
      // Every file this project lints (src/, scripts/, the various *.config.ts files) is already listed in tsconfig.json's own include -- no allowDefaultProject fallback list needed now that stamp-schema-ids has been converted from .mjs to .mts, closing the one gap that used to require it.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
  },
  ...exadev,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*TestWorld.ts", "src/test-helpers.ts"],
    plugins: { dial: dialPlugin },
    rules: {
      // Every dial target comes from one host rule (src/baseUrlDial.ts): a URL's host keeps an IPv6 literal's brackets and a colon split takes the literal's colons for a port, and either fails to dial.
      "dial/no-url-host-read": ["error", { allow: [
        // The host rule itself.
        { file: "src/baseUrlDial.ts", within: ["dialHostOf"] },
        // A URL printed for a person, never dialled.
        { file: "src/baseUrlDisplay.ts", within: ["displayBaseUrl"] },
        // Tests that an allowlist entry names a host: nothing connects to it.
        { file: "src/headroom/state.ts", within: ["isAdmissibleUrl"] },
        // Compares a base URL's host with a known provider's name: nothing connects to it.
        { file: "src/usage/providerQuota.ts", within: ["isHostedAt"] },
      ] }],
    },
  },

  {
    files: ["src/frontdoor/**/*.ts", "src/baseUrl*.ts", "src/provider*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*TestWorld.ts"],
    plugins: { dial: dialPlugin },
    rules: {
      // The code that turns an authority or a URL into a dial target never cuts one at a colon itself. The rule covers the code that dials (the front door, the base-URL and provider modules): elsewhere in src, string and pattern cuts at a colon parse times, headers, credential pairs and JSON keys, none an authority, so applying it there would only add allowances.
      "dial/no-colon-split": ["error", { allow: [
        // The shared authority parser itself.
        { file: "src/baseUrlDial.ts", within: ["parseDialAuthority"] },
        // A Basic credential pair, a header line and a server-sent-events field line: colon-separated, none an authority.
        { file: "src/frontdoor/capability.ts", within: ["capabilityFromProxyAuthorization"] },
        { file: "src/frontdoor/connect.ts", within: ["proxyAuthorizationOf"] },
        { file: "src/frontdoor/rcStream.ts", within: ["createSseParser"] },
        // The groups of an IPv6 address already cut out of any authority, which carry no port.
        { file: "src/frontdoor/x509.ts", within: ["ipv6Groups"] },
        // Patterns whose colon is not an authority's: a JSON key's, an RFC 5280 time's, a flag's `question:selection` separator, an IPv6 address's groups already cut out of any authority.
        { file: "src/frontdoor/requestScan.ts", within: ["scanRequestHead"] },
        { file: "src/frontdoor/x509.ts", within: ["time"] },
        { file: "src/frontdoor/rcCommands.ts", within: ["parseRcChoiceFlags"] },
        { file: "src/frontdoor/rcWebFetch.ts", within: ["isPrivateAddress"] },
      ] }],
    },
  },

  {
    files: ["src/frontdoor/doorDial.ts"],
    rules: {
      // The probe worker embeds these functions as source text, and a compiler targeting a syntax below ES2017 rewrites an `async` function into a call to a helper that lives in the bundle's scope and not in the worker's (`probe.test.ts` bundles the probe at es2015 to prove none is left), so they return promises explicitly.
      "@typescript-eslint/promise-function-async": "off",
    },
  },
  {
    files: ["src/doctorReport.ts"],
    rules: {
      // This file is the whole-config audit: one section per noun the tool owns, over shared validate-and-report helpers. Splitting it would duplicate those helpers across a file per noun.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/frontdoor/headroomHop.test.ts"],
    rules: {
      // This file is the whole-door integration harness (a fake headroom daemon, a TLS door over the production pipelines) plus one test per hop behaviour; every helper is shared by those tests and splitting it would duplicate the harness. Its size limit is lifted rather than the harness copied.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/launcher.test.ts"],
    rules: {
      // This file walks the whole launch pipeline end to end (guard, decision, daemons, environment) over one shared set of fakes; each launch facet is a test against the same rig, so splitting it would copy the rig. Its size limit is lifted rather than the rig copied.
      "max-lines": ["error", { max: 1000, skipComments: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/blockingSpawn.ts", "src/**/*.test.ts", "src/**/*TestWorld.ts", "src/test-helpers.ts"],
    rules: {
      // A synchronous spawn holds the calling thread for as long as the machine takes to start the process, and in the front door that thread answers every session: a loaded host stalled the door's loop past its watchdog this way. src/blockingSpawn.ts is the one place that calls them, refusing inside the door.
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:child_process", "child_process"].map((name) => ({
            name,
            importNames: ["spawnSync", "execFileSync", "execSync"],
            message: "Use spawnSyncBlocking from src/blockingSpawn.ts: it refuses to run inside the front door, whose event loop a synchronous spawn would hold.",
          })),
        },
      ],
    },
  },
  {
    files: ["src/frontdoor/doorWorker.ts", "src/frontdoor/probe.ts", "src/monotonicClock.ts"],
    rules: {
      // These files bound local durations (a worker's deadline and stall limit, a probe's wait): a wall clock that steps (a time sync, a daylight saving change) must not fire or stretch them, so they read the monotonic clock (`performance.now`, or `deadlineAfter`), which a sleeping system stretches and never shortens.
      "no-restricted-properties": ["error", { object: "Date", property: "now", message: "Bound a local duration on the monotonic clock: performance.now or deadlineAfter from src/monotonicClock.ts." }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      // A signal a caller did not give is absent, and stays `AbortSignal | undefined` end to end: a fresh `new AbortController().signal` in its place is a signal nothing can abort, which looks like cancellation support and gives none.
      "no-restricted-syntax": [
        "error",
        // `x ?? new AbortController().signal`, `(x ?? new AbortController()).signal`, `x || ...` and the same as a ternary, with the controller built inline or ahead of the expression (`x ?? controller.signal`): each hands a caller that gave no signal one nothing can abort.
        {
          selector: ":matches(LogicalExpression[operator='??'], LogicalExpression[operator='||']) > NewExpression.right[callee.name='AbortController']",
          message: "Keep an absent AbortSignal absent (AbortSignal | undefined) rather than substituting a controller nothing can abort.",
        },
        {
          selector: ":matches(LogicalExpression[operator='??'], LogicalExpression[operator='||']) > MemberExpression.right[property.name='signal']",
          message: "Keep an absent AbortSignal absent (AbortSignal | undefined) rather than substituting a signal nothing can abort.",
        },
        {
          selector: "ConditionalExpression > :matches(NewExpression[callee.name='AbortController'], MemberExpression[property.name='signal'])",
          message: "Keep an absent AbortSignal absent (AbortSignal | undefined) rather than substituting a signal nothing can abort.",
        },
      ],
    },
  },
  {
    rules: {
      // exadev's own consistent-type-imports leaves fixStyle at the rule's default (separate-type-imports); this repo prefers the type keyword inline on the same import statement instead.
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // This package publishes a library surface, so src/index.ts is its one legitimate barrel: the package entry point. 'single' still bans every other index file and every re-export outside it.
      "exadev/barrel-policy": ["error", { mode: "single" }],
    },
  },
]);
