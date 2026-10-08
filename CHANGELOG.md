## [8.43.0](https://github.com/ExaDev/agent-shim/compare/v8.42.0...v8.43.0) (2026-10-08)

### Features

* refresh the selected pool's stale usage before a library launch picks ([14951c3](https://github.com/ExaDev/agent-shim/commit/14951c3e9102a3621faaecbe494b4e8f35e49907))
* run a launch end to end over the real ports and return the exit code ([73fad6b](https://github.com/ExaDev/agent-shim/commit/73fad6b070aa4bf52adf3e9cd9308b4ab52a1171))

### Code Refactoring

* run a launch plan's child in one function that returns its exit code ([20c7945](https://github.com/ExaDev/agent-shim/commit/20c7945c4e884b3d8d5ed19f31d1f63d1cf84879))

### Documentation

* describe the pool usage refresh and the SDK stand-in for bundlers ([681b70e](https://github.com/ExaDev/agent-shim/commit/681b70e809aaac7390dcb868fc55b05dc7c9afae))
* list runClaudeLaunch and runLaunchPlan in the library surface ([e90fbd8](https://github.com/ExaDev/agent-shim/commit/e90fbd81d8da4204ac6cfc697791813db5f28863))

### Tests

* give the recorded launch plan the decision a plan now carries ([caaa6c9](https://github.com/ExaDev/agent-shim/commit/caaa6c9f2357beda511cb515449fac94fae42ae7))

## [8.42.0](https://github.com/ExaDev/agent-shim/compare/v8.41.0...v8.42.0) (2026-10-08)

### Features

* open the door's whole typed API client from the state root ([6a6a8d0](https://github.com/ExaDev/agent-shim/commit/6a6a8d0a386e6fcf742bdb33f2b4fe3b0bd07ff2))

### Code Refactoring

* read the serving door's control material in a library module ([290dbb2](https://github.com/ExaDev/agent-shim/commit/290dbb2f98c990cc7e24d20eeb7d0f5a46310909))

### Documentation

* describe frontDoorApiFromState in the library surface ([7293fe2](https://github.com/ExaDev/agent-shim/commit/7293fe2165bd51ad8089dcd9c5864c846064d7d5))

## [8.41.0](https://github.com/ExaDev/agent-shim/compare/v8.40.0...v8.41.0) (2026-10-08)

### Features

* export resolveLaunchSelection, the identity and profile a directory resolves to ([025eeed](https://github.com/ExaDev/agent-shim/commit/025eeed05789048a9fe9c004fc7c6249f3f19b1a))

### Code Refactoring

* take the identity and profile decision out of check ([7c48bb7](https://github.com/ExaDev/agent-shim/commit/7c48bb7d5145959f7d57a56ce3989060fcfca783))

### Documentation

* describe resolveLaunchSelection in the library surface ([785f12b](https://github.com/ExaDev/agent-shim/commit/785f12be55c1bd177e0858f494ad21a5e218de23))

## [8.40.0](https://github.com/ExaDev/agent-shim/compare/v8.39.0...v8.40.0) (2026-10-08)

### Features

* list the concrete identities a pool can launch as ([44d9461](https://github.com/ExaDev/agent-shim/commit/44d946137817fe2046ae857cf40fbed8dab7e8ca))
* report what a launch resolved to on the launch plan ([9f944de](https://github.com/ExaDev/agent-shim/commit/9f944de34844ad1e364ea681601f63a702910388))

### Documentation

* list poolIdentities and the launch decision in the library surface ([7f9fe35](https://github.com/ExaDev/agent-shim/commit/7f9fe35695026080ff0ad3d304451eb1413e9f5a))

## [8.39.0](https://github.com/ExaDev/agent-shim/compare/v8.38.1...v8.39.0) (2026-10-08)

### Features

* export the path of the package's own command line bundle ([8462a5c](https://github.com/ExaDev/agent-shim/commit/8462a5cf9c4fdd1083fa6d1351bd0bfb5177a7bc))
* start a launch's daemons through the package's own CLI by default ([1eabb13](https://github.com/ExaDev/agent-shim/commit/1eabb138520f4965367975876fe4e9fe8593544f))

### Build System

* record each library file's directory and check it finds the built CLI ([84869fc](https://github.com/ExaDev/agent-shim/commit/84869fc83748248cc03bd2f467e94957fc3c9f3a))

## [8.38.1](https://github.com/ExaDev/agent-shim/compare/v8.38.0...v8.38.1) (2026-10-08)

### Documentation

* name only the genuinely CLI-only parts as not in the library ([5473dd6](https://github.com/ExaDev/agent-shim/commit/5473dd68315785ca9e386b11ae793e43b76035ca))

## [8.38.0](https://github.com/ExaDev/agent-shim/compare/v8.37.0...v8.38.0) (2026-10-08)

### Features

* **usage:** refresh stale Anthropic usage before ranking a pool ([8e6beba](https://github.com/ExaDev/agent-shim/commit/8e6bebaa6fc749b58bafbfaf1081fe7187eaf34d))

### Build System

* bundle the Agent SDK into the CommonJS build ([860eef1](https://github.com/ExaDev/agent-shim/commit/860eef122bdbb44823aab341a47533d77b1fdf82))

## [8.37.0](https://github.com/ExaDev/agent-shim/compare/v8.36.0...v8.37.0) (2026-10-07)

### Features

* add tools, thinking and max_tokens as route predicates ([8e13978](https://github.com/ExaDev/agent-shim/commit/8e13978a1aefbe5f342cf7dae1615d97af73571d))

### Documentation

* name the pool and request facts in the conditions row ([bdbbb01](https://github.com/ExaDev/agent-shim/commit/bdbbb01a8f4efc936f84a6345d830831546e8593))

## [8.36.0](https://github.com/ExaDev/agent-shim/compare/v8.35.0...v8.36.0) (2026-10-07)

### Features

* complete per-request routing with image predicates, quota fallback and model rewriting ([b682304](https://github.com/ExaDev/agent-shim/commit/b68230450739dc1fb7e9c266fbfed237b8507a2e))

## [8.35.0](https://github.com/ExaDev/agent-shim/compare/v8.34.0...v8.35.0) (2026-10-07)

### Features

* route requests to a provider by the model they ask for ([f30cb06](https://github.com/ExaDev/agent-shim/commit/f30cb0622fd96f5bf7514f231ffcb6c3d22e13bb))

## [8.34.0](https://github.com/ExaDev/agent-shim/compare/v8.33.0...v8.34.0) (2026-10-07)

### Features

* drive pool member selection with when conditions ([b7263b5](https://github.com/ExaDev/agent-shim/commit/b7263b568ecf8dab51bb82dc0ff51f9dc84ff8c6))
* let a pool member entry carry a when condition ([33b03a4](https://github.com/ExaDev/agent-shim/commit/33b03a4968c6fec8cfb8746ae66764aebf46cd5b)), references [#177](https://github.com/ExaDev/agent-shim/issues/177)

## [8.33.0](https://github.com/ExaDev/agent-shim/compare/v8.32.0...v8.33.0) (2026-10-07)

### Features

* evaluate when conditions as trilean predicates ([aa201d6](https://github.com/ExaDev/agent-shim/commit/aa201d6b822fd29fb249d04944b3a85cc2047528))

## [8.32.0](https://github.com/ExaDev/agent-shim/compare/v8.31.0...v8.32.0) (2026-10-07)

### Features

* re-rank the pool at resume and continue, with stickiness that yields ([aa7b45b](https://github.com/ExaDev/agent-shim/commit/aa7b45b788e61536c5cc451027db3e7043cfe615))

## [8.31.0](https://github.com/ExaDev/agent-shim/compare/v8.30.0...v8.31.0) (2026-10-07)

### Features

* publish quota, door-health and expiring-quota events on the door's backbone ([30b1898](https://github.com/ExaDev/agent-shim/commit/30b18986b036355e7c7fda68501e7df9c5eb0558))

### Code Refactoring

* keep the seven-day window span module-private ([3f71f1e](https://github.com/ExaDev/agent-shim/commit/3f71f1e481e85849ac9cc2956521fa8829b8a1d6))

## [8.30.0](https://github.com/ExaDev/agent-shim/compare/v8.29.0...v8.30.0) (2026-10-07)

### Features

* serve the ranked pool pick on the door's typed API ([74e75fd](https://github.com/ExaDev/agent-shim/commit/74e75fdba931bc4c5faa4b65577af1f5fe8f9b46))

## [8.29.0](https://github.com/ExaDev/agent-shim/compare/v8.28.0...v8.29.0) (2026-10-07)

### Features

* serve the typed door API as REST with an OpenAPI document ([6bf9d55](https://github.com/ExaDev/agent-shim/commit/6bf9d55022560fb667cf03198c711d230f836f04))

### Code Refactoring

* keep the doc path and bearer reader module-private ([811ce9c](https://github.com/ExaDev/agent-shim/commit/811ce9c9a038a98b9c2ead2b85d990b0da9cd1da))

## [8.28.0](https://github.com/ExaDev/agent-shim/compare/v8.27.1...v8.28.0) (2026-10-07)

### Features

* **rig:** add the OAuth-capable MCP server the MCP OAuth proof needs ([e2766e9](https://github.com/ExaDev/agent-shim/commit/e2766e9c908cb97bc24f6404c8e7e2563a7e6408)), references [#272](https://github.com/ExaDev/agent-shim/issues/272)
* **rig:** drive the MCP OAuth walk from the mock provider ([a4fb15e](https://github.com/ExaDev/agent-shim/commit/a4fb15e634bbad7bf0e2dbbd0613d7d5de20a8d1))

### Documentation

* describe the MCP OAuth proof on the interception rig ([65b9c61](https://github.com/ExaDev/agent-shim/commit/65b9c612b51ceb19cf0a2ca0c69649df552c6c72)), references [#271](https://github.com/ExaDev/agent-shim/issues/271)

## [8.27.1](https://github.com/ExaDev/agent-shim/compare/v8.27.0...v8.27.1) (2026-10-07)

### Bug Fixes

* **launcher:** exempt loopback from the door's proxy via NO_PROXY ([e0c1cf4](https://github.com/ExaDev/agent-shim/commit/e0c1cf4f2b7b85b1fb3834974134d17ad3569779)), closes [#271](https://github.com/ExaDev/agent-shim/issues/271)

## [8.27.0](https://github.com/ExaDev/agent-shim/compare/v8.26.0...v8.27.0) (2026-10-06)

### Features

* **rc:** key self-hosted event logs by conversation above cse sessions ([1111f81](https://github.com/ExaDev/agent-shim/commit/1111f81d2663ca566684676620e7dd0fcbbe764b)), references [#238](https://github.com/ExaDev/agent-shim/issues/238) [#238](https://github.com/ExaDev/agent-shim/issues/238) [#260](https://github.com/ExaDev/agent-shim/issues/260)

### Bug Fixes

* **rc:** keep the split self-host modules' own vocabulary private ([915503c](https://github.com/ExaDev/agent-shim/commit/915503ca386e9ca2597d5327c569ca3c82d71ffc))

## [8.26.0](https://github.com/ExaDev/agent-shim/compare/v8.25.0...v8.26.0) (2026-10-06)

### Features

* **rc:** serve live rate_limit_event envelopes as a real-time usage source ([b4593de](https://github.com/ExaDev/agent-shim/commit/b4593de514d7867383c025ad3adf3860d35d2588))

## [8.25.0](https://github.com/ExaDev/agent-shim/compare/v8.24.0...v8.25.0) (2026-10-06)

### Features

* **rc:** serve every undriven Remote Control endpoint on the door ([08be766](https://github.com/ExaDev/agent-shim/commit/08be7665b811bc8dbf213ab7a549174187a101ff))

## [8.24.0](https://github.com/ExaDev/agent-shim/compare/v8.23.0...v8.24.0) (2026-10-06)

### Features

* **rc:** send every remaining SDK control verb as a door client-half write ([ddb3901](https://github.com/ExaDev/agent-shim/commit/ddb39017fe84b7f09662b046f831d88c87be8df5))

### Code Refactoring

* **rc:** inline the detail and encoding enum schemas into their inputs ([65cef8f](https://github.com/ExaDev/agent-shim/commit/65cef8f58cf115d973c654bf5c0c2163e0503372))

## [8.23.0](https://github.com/ExaDev/agent-shim/compare/v8.22.0...v8.23.0) (2026-10-06)

### Features

* **update:** config-gated automatic update check and background apply at launch ([40df4c5](https://github.com/ExaDev/agent-shim/commit/40df4c5d2e33630f21a8fd719538bfc097b53464))

## [8.22.0](https://github.com/ExaDev/agent-shim/compare/v8.21.1...v8.22.0) (2026-10-06)

### Features

* **cli:** add agent-shim update to install the newest release binary ([f2121fe](https://github.com/ExaDev/agent-shim/commit/f2121feb1e44e02127ec6b36607620683fc90db2))

## [8.21.1](https://github.com/ExaDev/agent-shim/compare/v8.21.0...v8.21.1) (2026-10-06)

### Bug Fixes

* **rc:** name the presentation's shape in the self-host refusal ([9d192c7](https://github.com/ExaDev/agent-shim/commit/9d192c7df5b390c026180c0d6771dc1b625535e0)), references [#264](https://github.com/ExaDev/agent-shim/issues/264)

## [8.21.0](https://github.com/ExaDev/agent-shim/compare/v8.20.2...v8.21.0) (2026-10-06)

### Features

* **rc:** serve the worker's web-fetch and web-search proxies on the self-hosted surface ([f3ed737](https://github.com/ExaDev/agent-shim/commit/f3ed7375c4436f1e630a63b397b8a97ddc0de943))

### Bug Fixes

* **rc:** accept the CLI's real web-proxy credential and drive the fetch proof on the rig ([c01f5a3](https://github.com/ExaDev/agent-shim/commit/c01f5a3d5814f187e4bde3b6f99ed3d4f6a339bb))

## [8.20.2](https://github.com/ExaDev/agent-shim/compare/v8.20.1...v8.20.2) (2026-10-06)

### Bug Fixes

* **frontdoor:** attribute headroom traffic with the launch session id ([8b0c970](https://github.com/ExaDev/agent-shim/commit/8b0c97027b3fa1f9dd0aebdba9a7ea17b51239bb))

## [8.20.1](https://github.com/ExaDev/agent-shim/compare/v8.20.0...v8.20.1) (2026-10-06)

### Bug Fixes

* **rule:** accept a pool selector as a directory rule's identity ([658dfe1](https://github.com/ExaDev/agent-shim/commit/658dfe1cb3471bc3be7eecad3daa4e75ad282bf2))

## [8.20.0](https://github.com/ExaDev/agent-shim/compare/v8.19.0...v8.20.0) (2026-10-06)

### Features

* **pool:** let a pool nest another pool as a member, evaluated with its own policy ([3fcd626](https://github.com/ExaDev/agent-shim/commit/3fcd626aa00b2a45ad56df7ca53844a5babd3664))
* **pool:** rank pool members in listed order as a preference mode ([5f985a2](https://github.com/ExaDev/agent-shim/commit/5f985a271cdd66ecc4d6863ba5dc32aeb8b858c9))

### Code Refactoring

* **pool:** keep the member and preference schemas module-local ([982da05](https://github.com/ExaDev/agent-shim/commit/982da05915c038b4ecfa789f330bdb58930bc138))

## [8.19.0](https://github.com/ExaDev/agent-shim/compare/v8.18.0...v8.19.0) (2026-10-06)

### Features

* **rig:** let the mock provider dump request bodies and drive the tool-search flow ([30ab0f6](https://github.com/ExaDev/agent-shim/commit/30ab0f6928369ced6275dc92dc8629db46d7883c)), references [#226](https://github.com/ExaDev/agent-shim/issues/226)

## [8.18.0](https://github.com/ExaDev/agent-shim/compare/v8.17.1...v8.18.0) (2026-10-06)

### Features

* **launcher:** route provider sessions through the door's OAuth path ([89ceef3](https://github.com/ExaDev/agent-shim/commit/89ceef3fa634e213084aaf495c81c21708e3292a))
* **rig:** add the mock provider the self-hosted Remote Control proof needs ([30e5f1e](https://github.com/ExaDev/agent-shim/commit/30e5f1ed8cde0503293f3fe413de3a16656aca9d))

### Bug Fixes

* **frontdoor:** attach an http provider's own credential at its route ([b64de52](https://github.com/ExaDev/agent-shim/commit/b64de527405f9117342891d6c695e7220065dd9a))

### Documentation

* describe the OAuth-shaped provider session and its door-attached credential ([03551dc](https://github.com/ExaDev/agent-shim/commit/03551dc6e9acde74753a591c08715b7bc0c1ce7d))
* **frontdoor:** keep the credential-attach comment honest about the launcher ([53fc319](https://github.com/ExaDev/agent-shim/commit/53fc319ea24e46df71539dae88fd8cb479a3ae61))
* **launcher:** drop the stale base URL sentence from buildEnv's contract ([cde2292](https://github.com/ExaDev/agent-shim/commit/cde22928ed8c5cdd218cf7e7bc538dca223f628f))

## [8.17.1](https://github.com/ExaDev/agent-shim/compare/v8.17.0...v8.17.1) (2026-10-05)

### Bug Fixes

* **frontdoor:** make the web client's door-state indicator truthful ([146eb20](https://github.com/ExaDev/agent-shim/commit/146eb20027381696bd5a1e68194b884870edbce7))

## [8.17.0](https://github.com/ExaDev/agent-shim/compare/v8.16.0...v8.17.0) (2026-10-05)

### Features

* **frontdoor:** let the listener serve several pre-pipeline API surfaces ([4a3ac24](https://github.com/ExaDev/agent-shim/commit/4a3ac2451f3fb0b0d85fe8ca47af5e83382ac8e7))
* **frontdoor:** serve the self-hosted Remote Control web client ([ddd8cb9](https://github.com/ExaDev/agent-shim/commit/ddd8cb97b573983959bc47a6d561fb4fe1cab43d)), closes [#249](https://github.com/ExaDev/agent-shim/issues/249)

### Documentation

* describe the self-hosted Remote Control web client ([de9aeba](https://github.com/ExaDev/agent-shim/commit/de9aebaa19ddce43296f5e4a4d4c7d918e49268e))

## [8.16.0](https://github.com/ExaDev/agent-shim/compare/v8.15.0...v8.16.0) (2026-10-05)

### Features

* **codex:** add codex login and logout and report the sign-in in codex status ([30916e7](https://github.com/ExaDev/agent-shim/commit/30916e7e28ce4eba6b718c0552645c328304e59d))
* **codex:** add the Sign in with ChatGPT protocol and grant store ([cf8d73b](https://github.com/ExaDev/agent-shim/commit/cf8d73bcb147f83517adaa4a45c843516f2cefb0))
* **codex:** choose a codex provider's login and upstream per provider ([a2003cc](https://github.com/ExaDev/agent-shim/commit/a2003cc58e479f3de313ce1a8d7fbdf9ee85f5d1))
* **codex:** set a provider's login from the CLI and warn in doctor when no sign-in exists ([77b9aad](https://github.com/ExaDev/agent-shim/commit/77b9aad479ef44d8e0517f8670d41aaa993c9815))
* **frontdoor:** generalise the door's event fan-out into an event backbone ([1cd97e7](https://github.com/ExaDev/agent-shim/commit/1cd97e709b7e5f828d2f5d792f5d74b98e8d58a2))

### Bug Fixes

* **codex:** follow the Sign in with ChatGPT SDK's registration behaviour ([7706d1d](https://github.com/ExaDev/agent-shim/commit/7706d1dc9549e62ec68a67a50fa64be1229684f5))

### Documentation

* describe Sign in with ChatGPT as a codex provider login ([1ae85f8](https://github.com/ExaDev/agent-shim/commit/1ae85f8e65f5000c7cebadd0277b669912b557f9))
* mark the chatgpt-sign-in login experimental ([a95df2b](https://github.com/ExaDev/agent-shim/commit/a95df2b2ee1179e3e7f523c0fdd428e56fd970d7))
* note that a managed ChatGPT workspace can refuse the Sign in with ChatGPT consent ([d6e1541](https://github.com/ExaDev/agent-shim/commit/d6e1541ec223063eba661049e0829f5d1f083c4a))

### Tests

* pass the sign-in file to the e2e route ports and scope the sign-in doctor findings ([b147e09](https://github.com/ExaDev/agent-shim/commit/b147e09329057002ee04e1580f4fc2ac36c5e8ac))

## [8.15.0](https://github.com/ExaDev/agent-shim/compare/v8.14.1...v8.15.0) (2026-10-05)

### Features

* **check:** define the report's JSON form as a Zod schema ([9a7c775](https://github.com/ExaDev/agent-shim/commit/9a7c775a52a7e6faeace7640c2f994d9e973dcd1))
* **frontdoor:** serve the door's control plane on the typed API mount ([d6cc022](https://github.com/ExaDev/agent-shim/commit/d6cc0225a53806172d444ca86545c98b08903ae5))

### Code Refactoring

* **report:** derive the report vocabularies from shared const arrays ([04140a7](https://github.com/ExaDev/agent-shim/commit/04140a711bb52455fc7c390532b7d565307ae2f3))

### Documentation

* **frontdoor:** document the door's control plane ([ef1d2b9](https://github.com/ExaDev/agent-shim/commit/ef1d2b9aa663487cb5d58202ed2aa30289cc1c53))

## [8.14.1](https://github.com/ExaDev/agent-shim/compare/v8.14.0...v8.14.1) (2026-10-05)

### Bug Fixes

* **frontdoor:** close the RC stream hub when the supervisor stops ([20f14ea](https://github.com/ExaDev/agent-shim/commit/20f14ea5fe74efc4bcc32113adb239d05bf82ddd)), closes [#243](https://github.com/ExaDev/agent-shim/issues/243)

### Tests

* give every test and hook a hang-guard timeout sized for a loaded machine ([7e097ce](https://github.com/ExaDev/agent-shim/commit/7e097cee1da283c13a077ca3c9cbce67e0366036))
* keep the latency and walk-policy tests valid on a loaded machine ([c42573b](https://github.com/ExaDev/agent-shim/commit/c42573bfc44f6d793ad492b12bc78b24318eff65))
* remove the fixed pauses from the detach and streaming tests ([9071e63](https://github.com/ExaDev/agent-shim/commit/9071e63300ff4679ce1449688b077045b3a2d5d1))

## [8.14.0](https://github.com/ExaDev/agent-shim/compare/v8.13.0...v8.14.0) (2026-10-05)

### Features

* **frontdoor:** persist the RC stream hub's sequence cursor beside the credential ([72f55e5](https://github.com/ExaDev/agent-shim/commit/72f55e570711714e4ca03a9a9ba5db0510ac6da4)), references [#238](https://github.com/ExaDev/agent-shim/issues/238)

## [8.13.0](https://github.com/ExaDev/agent-shim/compare/v8.12.0...v8.13.0) (2026-10-05)

### Features

* **library:** export runLauncher and spawnClaude so launching is one call ([a302af6](https://github.com/ExaDev/agent-shim/commit/a302af6a24d10b25b01acfa9ca48b5c5e2ea9d68))

### Documentation

* **library:** name the launch spawn exports' ordering guarantee ([885af3e](https://github.com/ExaDev/agent-shim/commit/885af3e93a27dd4fa72b1c58c632040da811e0ca))

## [8.12.0](https://github.com/ExaDev/agent-shim/compare/v8.11.3...v8.12.0) (2026-10-05)

### Features

* **frontdoor:** answer the CLI's startup token validation locally ([944759b](https://github.com/ExaDev/agent-shim/commit/944759b53a985bd1adabcf46d0663b2faad2bd7a))
* **frontdoor:** mint the local credential and wire the door's self-hosted mode ([79d6852](https://github.com/ExaDev/agent-shim/commit/79d68529bd060a3139f01addeec4f520a5204402))
* **frontdoor:** serve the Remote Control session family on the door itself ([1e454d4](https://github.com/ExaDev/agent-shim/commit/1e454d478bb414acf9d97342e02e6676cd1d021f))

### Bug Fixes

* **frontdoor:** read the worker state from the field the CLI sends ([99741f7](https://github.com/ExaDev/agent-shim/commit/99741f7d566a4ece28e930a6240550f114b51790))

### Documentation

* describe the self-hosted proof on the interception rig ([11e25ab](https://github.com/ExaDev/agent-shim/commit/11e25abd93ab6e672e1ca8a9c6d066a8459ae7de))

### Tests

* **frontdoor:** cover the self-hosted surface and its end-to-end assembly ([a968615](https://github.com/ExaDev/agent-shim/commit/a968615738212c8b4f104a164948ac24e40016f7))

## [8.11.3](https://github.com/ExaDev/agent-shim/compare/v8.11.2...v8.11.3) (2026-10-05)

### Documentation

* name the eager tool loading every provider session gets, and the env-block lever ([c2bccf5](https://github.com/ExaDev/agent-shim/commit/c2bccf58a7aed74e928e9edf211df9e6fb75b8db))

## [8.11.2](https://github.com/ExaDev/agent-shim/compare/v8.11.1...v8.11.2) (2026-10-05)

### Documentation

* state the terms position of the Codex login translation ([6dadbf6](https://github.com/ExaDev/agent-shim/commit/6dadbf6ce34e4c85bd36deebd40b8a18556eb34e))

## [8.11.1](https://github.com/ExaDev/agent-shim/compare/v8.11.0...v8.11.1) (2026-10-05)

### Code Refactoring

* **frontdoor:** inject the source-port range into the exempt dials ([8c4ea4d](https://github.com/ExaDev/agent-shim/commit/8c4ea4d82a4558dedb7e116dc85ffb28b43feb8c))

## [8.11.0](https://github.com/ExaDev/agent-shim/compare/v8.10.0...v8.11.0) (2026-10-05)

### Features

* **frontdoor:** log the RC stream attachment's lifecycle ([cb10beb](https://github.com/ExaDev/agent-shim/commit/cb10bebbeae0b907bb2c2757286c377773e81be5))

### Bug Fixes

* **frontdoor:** persist the Remote Control client credential across door generations ([1d2289b](https://github.com/ExaDev/agent-shim/commit/1d2289b3daf2e767767372bf88602a3cfab6afb5))

## [8.10.0](https://github.com/ExaDev/agent-shim/compare/v8.9.0...v8.10.0) (2026-10-05)

### Features

* **check:** report the Claude Code version and warn about a pin that is not installed ([44ce129](https://github.com/ExaDev/agent-shim/commit/44ce129061b91e0a23301dd0ea903dd8904a35fd))
* **launcher:** pin the Claude Code version a launch runs ([577924f](https://github.com/ExaDev/agent-shim/commit/577924f7c0ccb70a7853668d48d557afd0378b3c))

### Documentation

* describe pinning the Claude Code version ([5c9d1e3](https://github.com/ExaDev/agent-shim/commit/5c9d1e3451479ae77df47e13b11288f96b3c07ba))

### Tests

* **frontdoor:** treat an already-bound reserved port as held ([7fb2600](https://github.com/ExaDev/agent-shim/commit/7fb260042181df7ee5f2fdd3c35d671eef6e53cf))

## [8.9.0](https://github.com/ExaDev/agent-shim/compare/v8.8.0...v8.9.0) (2026-10-05)

### Features

* **frontdoor:** hold the Remote Control client read stream and serve its operations as a typed oRPC API ([22b4fd0](https://github.com/ExaDev/agent-shim/commit/22b4fd060146f16db28b31551ad5883d40c90b63)), references [#206](https://github.com/ExaDev/agent-shim/issues/206)
* **launcher:** add --native to run the real claude with nothing from agent-shim applied ([66bfdd9](https://github.com/ExaDev/agent-shim/commit/66bfdd99599987fd2e0fd55d9cec683aeaefbd42))

## [8.8.0](https://github.com/ExaDev/agent-shim/compare/v8.7.0...v8.8.0) (2026-10-05)

### Features

* **library:** export the pool ranking, effectiveWindow and the condition evaluator ([3677a5f](https://github.com/ExaDev/agent-shim/commit/3677a5fdbc83b3d81ae382320a4096336276baa4))

### Bug Fixes

* **frontdoor:** dial a tap session's upstream through the bounded reserved dial ([c595c35](https://github.com/ExaDev/agent-shim/commit/c595c35bec77a1c7c315df30a0bb569d71bc8276))

### Code Refactoring

* **usage:** define the pool pick report and plan class as schemas ([24efbfc](https://github.com/ExaDev/agent-shim/commit/24efbfc11a62c4c892e562346fc22e289d4512ed))

## [8.7.0](https://github.com/ExaDev/agent-shim/compare/v8.6.0...v8.7.0) (2026-10-05)

### Features

* **check:** show the age of a cached credential in check and doctor ([0e9bad5](https://github.com/ExaDev/agent-shim/commit/0e9bad52a8caca20acc4b472306ab28ca6ad7963))

## [8.6.0](https://github.com/ExaDev/agent-shim/compare/v8.5.6...v8.6.0) (2026-10-04)

### Features

* **frontdoor:** send the client half's own control requests into a session ([ecbc27b](https://github.com/ExaDev/agent-shim/commit/ecbc27bd396456c2d9bcace152d97ee0d4ca4253))

### Tests

* **frontdoor:** bound the hop's added latency floor, not its median difference ([9195503](https://github.com/ExaDev/agent-shim/commit/9195503e5167e4d2c5a791ad2f13d821a9e834f7))

## [8.5.6](https://github.com/ExaDev/agent-shim/compare/v8.5.5...v8.5.6) (2026-10-04)

### Bug Fixes

* print the agent-shim prefix once on a door or headroom start failure ([6dd825b](https://github.com/ExaDev/agent-shim/commit/6dd825bc1f4df2a5467a949161fb75378487a937))

## [8.5.5](https://github.com/ExaDev/agent-shim/compare/v8.5.4...v8.5.5) (2026-10-04)

### Bug Fixes

* **frontdoor:** read a sequence number the API returns as a JSON string ([9ffe00d](https://github.com/ExaDev/agent-shim/commit/9ffe00dc6043e3293b625f8f7556caba36c3ef23))

## [8.5.4](https://github.com/ExaDev/agent-shim/compare/v8.5.3...v8.5.4) (2026-10-04)

### Bug Fixes

* **frontdoor:** replace the state file atomically ([43309a4](https://github.com/ExaDev/agent-shim/commit/43309a4317e1693920eb70aed9b72374c184548a))
* **headroom:** do not register a provider launch against a daemon that predates its allowlist ([375389e](https://github.com/ExaDev/agent-shim/commit/375389e75319e7f10a0f5ebad5a435052c28877a))

## [8.5.3](https://github.com/ExaDev/agent-shim/compare/v8.5.2...v8.5.3) (2026-10-04)

### Bug Fixes

* **frontdoor:** keep the worker JWT from displacing the OAuth injection credential ([10264c1](https://github.com/ExaDev/agent-shim/commit/10264c126e63db0e0a0eef3f4e595b6d89981ded))

### Tests

* **frontdoor:** keep fake bearers under the redaction filter's threshold ([c4d8af1](https://github.com/ExaDev/agent-shim/commit/c4d8af162d43ca6e5fbadf6c936f8fdba1233ed2))

## [8.5.2](https://github.com/ExaDev/agent-shim/compare/v8.5.1...v8.5.2) (2026-10-04)

### Bug Fixes

* **discovery:** accept a foreign claude sharing agent-shim's own bin directory ([ec6c183](https://github.com/ExaDev/agent-shim/commit/ec6c183e92a0f303194aca39975886b137ef8cc5)), references [#188](https://github.com/ExaDev/agent-shim/issues/188)

## [8.5.1](https://github.com/ExaDev/agent-shim/compare/v8.5.0...v8.5.1) (2026-10-04)

### Bug Fixes

* **frontdoor:** check a failed resolve before reading its addresses ([f4bb6fd](https://github.com/ExaDev/agent-shim/commit/f4bb6fdf6dbcf8a130b07d15b9110b093330cae0))
* **frontdoor:** retry an exempt dial's held reserved port on the next of the range ([3e957b6](https://github.com/ExaDev/agent-shim/commit/3e957b6e71ab64b2da8e11e9c455058f20612646))

## [8.5.0](https://github.com/ExaDev/agent-shim/compare/v8.4.1...v8.5.0) (2026-10-04)

### Features

* **scripts:** add a harness that replays transcripts through scratch headroom daemons ([fb8e076](https://github.com/ExaDev/agent-shim/commit/fb8e07656a7cff3c35dcb6a305c6caeb52c222f5))
* **scripts:** add the pure core of a headroom measurement harness ([94d94bf](https://github.com/ExaDev/agent-shim/commit/94d94bff7807c9cb7232114050789ebccc4234cb))
* **scripts:** select measurement variants by repeatable --variant and add token-mode combinations ([54c6516](https://github.com/ExaDev/agent-shim/commit/54c6516e07d706f49e847809c3e1d3db80e05fec))

### Documentation

* describe how headroom's transforms are measured ([ec466f7](https://github.com/ExaDev/agent-shim/commit/ec466f799e5a779541f87145ed51a838a1d2992c))

## [8.4.1](https://github.com/ExaDev/agent-shim/compare/v8.4.0...v8.4.1) (2026-10-04)

### Bug Fixes

* **headroom:** start the daemon with its local rate limiter off ([d56306d](https://github.com/ExaDev/agent-shim/commit/d56306d3a367afebcf2911644d7ea21cc8c26f3e))

## [8.4.0](https://github.com/ExaDev/agent-shim/compare/v8.3.0...v8.4.0) (2026-10-04)

### Features

* **frontdoor:** observe and answer Remote Control control requests ([87ffcd5](https://github.com/ExaDev/agent-shim/commit/87ffcd57335e78f72f22ed7cda85ae3d4c3a37de))

### Documentation

* **cli-reference:** list the frontdoor rc verbs in the full command list ([957c419](https://github.com/ExaDev/agent-shim/commit/957c4197c62c80e31a2aea458f9ae02bf0d638c0)), references [#136](https://github.com/ExaDev/agent-shim/issues/136)

## [8.3.0](https://github.com/ExaDev/agent-shim/compare/v8.2.0...v8.3.0) (2026-10-04)

### Features

* **frontdoor:** expose Remote Control sessions over the frontdoor rc verbs ([5a095f5](https://github.com/ExaDev/agent-shim/commit/5a095f54088d423a027c5a0f954226d181bda820))
* **frontdoor:** track Remote Control sessions and inject prompts as the client half ([3bc279e](https://github.com/ExaDev/agent-shim/commit/3bc279e94aebe8890860824e6eed479d3f93fe0e))

## [8.2.0](https://github.com/ExaDev/agent-shim/compare/v8.1.0...v8.2.0) (2026-10-04)

### Features

* **scripts:** add a door mode to the RC interception rig ([dbac8ac](https://github.com/ExaDev/agent-shim/commit/dbac8acc026bc058381a8e52f3b4438c6850ade7))

## [8.1.0](https://github.com/ExaDev/agent-shim/compare/v8.0.2...v8.1.0) (2026-10-04)

### Features

* **scripts:** codify the RC interception rig as a bring-up script ([49a4da5](https://github.com/ExaDev/agent-shim/commit/49a4da50bc08baca397b5b6b5fd1cd3fd377e80e)), closes [#184](https://github.com/ExaDev/agent-shim/issues/184), references [#136](https://github.com/ExaDev/agent-shim/issues/136) [#137](https://github.com/ExaDev/agent-shim/issues/137) [#182](https://github.com/ExaDev/agent-shim/issues/182)

## [8.0.2](https://github.com/ExaDev/agent-shim/compare/v8.0.1...v8.0.2) (2026-10-04)

### Bug Fixes

* **frontdoor:** terminate the transparent surface per host keyed on SNI ([07618a4](https://github.com/ExaDev/agent-shim/commit/07618a462c8c3a9b958dc5e7e6394cd08b6bd2c9))

### Documentation

* **frontdoor:** describe the connect surface's per-host termination ([b159d02](https://github.com/ExaDev/agent-shim/commit/b159d0215aaccc042ab35d8570dce2ab84529e40))

## [8.0.1](https://github.com/ExaDev/agent-shim/compare/v8.0.0...v8.0.1) (2026-10-04)

### Bug Fixes

* **headroom:** hand headroom the door's CA by path through HEADROOM_CA_BUNDLE ([f3028d2](https://github.com/ExaDev/agent-shim/commit/f3028d2ffa86ad5fc9458b4bc71682c2579dbe49)), closes [#172](https://github.com/ExaDev/agent-shim/issues/172)

### Code Refactoring

* **frontdoor:** name the trust variable a combined bundle is resolved for ([3b43f4a](https://github.com/ExaDev/agent-shim/commit/3b43f4ae8362522f7b1d65ee1371c8f553865ad0))

## [8.0.0](https://github.com/ExaDev/agent-shim/compare/v7.14.0...v8.0.0) (2026-10-04)

### ⚠ BREAKING CHANGES

* **headroom:** ensureHeadroom returns { socketPath } instead of { port };
  SupervisorPorts drops freePort and isPortFree, gains socketTrust, and its
  spawnHeadroom and ready take the socket path; LayoutPaths gains
  headroomSocketDir and headroomStateFile names state.v2.json. Launched
  sessions no longer receive HEADROOM_PROXY_URL, since the daemon has no
  TCP address.

### Bug Fixes

* **headroom:** pin the fork commit that adds proxy --uds ([bf36064](https://github.com/ExaDev/agent-shim/commit/bf36064b395ec9d78da47eca06c6c19dc490c659))
* **headroom:** reach the headroom daemon only over an owner-only unix socket ([eb2a25c](https://github.com/ExaDev/agent-shim/commit/eb2a25c9ff82a5e6b63f8a9cd0554ba50bc2c04f)), closes [#68](https://github.com/ExaDev/agent-shim/issues/68)

## [7.14.0](https://github.com/ExaDev/agent-shim/compare/v7.13.2...v7.14.0) (2026-10-04)

### Features

* **frontdoor:** make the door's upstream dials interception-proof ([4eadab3](https://github.com/ExaDev/agent-shim/commit/4eadab3c52e98d52dc81445aa272935de523eaae))

## [7.13.2](https://github.com/ExaDev/agent-shim/compare/v7.13.1...v7.13.2) (2026-10-03)

### Bug Fixes

* **types:** bundle library declarations into one file ([41d3ef8](https://github.com/ExaDev/agent-shim/commit/41d3ef87cfc848ffb391e3afe728d878d96bdbf0))
* **usage:** publish the UsageRecord JSON Schema ([2d07dbd](https://github.com/ExaDev/agent-shim/commit/2d07dbddc5f1df7970f19a1995e362bd1a09745d))

## [7.13.1](https://github.com/ExaDev/agent-shim/compare/v7.13.0...v7.13.1) (2026-10-03)

### Bug Fixes

* walk only the directories of ~/.claude that a rule can tell apart ([e388b74](https://github.com/ExaDev/agent-shim/commit/e388b7480079b7f76d059e5658e55d3d817873e8))

## [7.13.0](https://github.com/ExaDev/agent-shim/compare/v7.12.1...v7.13.0) (2026-10-03)

### Features

* prepare a launch from the library with prepareClaudeLaunch ([a63fff9](https://github.com/ExaDev/agent-shim/commit/a63fff93ab356bb320eda6729df56ad48f405493))

### Code Refactoring

* move the commander-free pair parsers out of the commander module ([50710b3](https://github.com/ExaDev/agent-shim/commit/50710b3d3e2a7cfb0778bc22bcc714bbeca9a113))
* split preparing a launch from spawning the child ([c78215c](https://github.com/ExaDev/agent-shim/commit/c78215c7bfff3a78c100d24c0dd5c8c280e54ecf))

### Continuous Integration

* publish the former name to GitHub Packages as well ([e277936](https://github.com/ExaDev/agent-shim/commit/e2779360b29dd5c8058055069a34c0e8e9b85e56))

## [7.12.1](https://github.com/ExaDev/agent-shim/compare/v7.12.0...v7.12.1) (2026-10-03)

### Bug Fixes

* **frontdoor:** say which request and phase a failed headroom hop belongs to ([0544c45](https://github.com/ExaDev/agent-shim/commit/0544c4572393025e550a01a2c1dade54e70c5a3d))

## [7.12.0](https://github.com/ExaDev/agent-shim/compare/v7.11.0...v7.12.0) (2026-10-03)

### Features

* print JSON from the mutating commands with --json ([628527b](https://github.com/ExaDev/agent-shim/commit/628527b19847233520229cde1eda7532069508fc))

## [7.11.0](https://github.com/ExaDev/agent-shim/compare/v7.10.2...v7.11.0) (2026-10-03)

### Features

* **frontdoor:** serve a transparent surface for redirect-arriving traffic ([cb2b3a6](https://github.com/ExaDev/agent-shim/commit/cb2b3a67f53d07595be4434d28f8ae4bb2e2b2d5))

## [7.10.2](https://github.com/ExaDev/agent-shim/compare/v7.10.1...v7.10.2) (2026-10-03)

### Documentation

* state plainly that Remote Control's websocket bypasses the proxy ([6b8c25f](https://github.com/ExaDev/agent-shim/commit/6b8c25fcc53694780e55dd529c23aa8229678a83))

## [7.10.1](https://github.com/ExaDev/agent-shim/compare/v7.10.0...v7.10.1) (2026-10-03)

### Bug Fixes

* **frontdoor:** give the headroom hop its own no-keep-alive agent ([2922ce8](https://github.com/ExaDev/agent-shim/commit/2922ce8a4cc1cb442191c192e08edbbc6a46d144))

## [7.10.0](https://github.com/ExaDev/agent-shim/compare/v7.9.0...v7.10.0) (2026-10-03)

### Features

* **frontdoor:** tee the relayed websocket into the capture and decode it offline ([9ba5ebd](https://github.com/ExaDev/agent-shim/commit/9ba5ebd03938206abd47cebc2ad5cd8d394bcddc))

## [7.9.0](https://github.com/ExaDev/agent-shim/compare/v7.8.0...v7.9.0) (2026-10-03)

### Features

* export check and doctor from the library as functions that return a report ([2b56892](https://github.com/ExaDev/agent-shim/commit/2b56892a2e7d4ffad278e300372b9c049a5bf116))

### Code Refactoring

* move the boolean environment variable parsing out of the commander module ([df60ba5](https://github.com/ExaDev/agent-shim/commit/df60ba551bbd50464c19f487c67d46197788e838))
* move the pool pick ranking report out of the pool command module ([99224a2](https://github.com/ExaDev/agent-shim/commit/99224a2fb062c458cc58691ede962897dd13782d))
* split the check report from the check command and collect it in one call ([748b4da](https://github.com/ExaDev/agent-shim/commit/748b4dac3a34b2f8335455af8a360caa33a10809))
* split the doctor report from the doctor command and collect it in one call ([430eebe](https://github.com/ExaDev/agent-shim/commit/430eebe8665748889ab1a089e17c06ffa949c45c))

## [7.8.0](https://github.com/ExaDev/agent-shim/compare/v7.7.0...v7.8.0) (2026-10-03)

### Features

* export the identity, profile, provider, pool and directory rule data layers from the library ([85c90ec](https://github.com/ExaDev/agent-shim/commit/85c90ecb609f15c18279c2325cb910e312c27a8b))

### Code Refactoring

* move the configuration profile data functions into configProfilesStore ([3d16088](https://github.com/ExaDev/agent-shim/commit/3d16088dc820a13ff922dcd2b1bf38173d706ba9))
* move the directory rule data functions into directoryRulesStore ([bb80e5e](https://github.com/ExaDev/agent-shim/commit/bb80e5e68026728ca5a33490273ac28e44a43d4c))
* move the identity data functions into identityStore ([714773d](https://github.com/ExaDev/agent-shim/commit/714773d06994eb03e85eb69d8c25ab6c9df68de7))
* move the provider data functions into providersStore ([68c34e6](https://github.com/ExaDev/agent-shim/commit/68c34e648ade2e37fd143e1174e0470885de4b76))

## [7.7.0](https://github.com/ExaDev/agent-shim/compare/v7.6.1...v7.7.0) (2026-10-03)

### Features

* **frontdoor:** admit a routed request by its tunnel's capability ([a59f72c](https://github.com/ExaDev/agent-shim/commit/a59f72cd2f6fefa9f1efa527b436bce0e2782b29))
* **frontdoor:** relay websocket upgrades on terminated sessions ([9d0f68b](https://github.com/ExaDev/agent-shim/commit/9d0f68bde2a302fad21be9a3bda16562ddbd0f0a))

## [7.6.1](https://github.com/ExaDev/agent-shim/compare/v7.6.0...v7.6.1) (2026-10-03)

### Bug Fixes

* **frontdoor:** replace a door older than the launcher instead of joining it ([2c3cba6](https://github.com/ExaDev/agent-shim/commit/2c3cba615799b379f4a3993ff6e35ce401676908))

## [7.6.0](https://github.com/ExaDev/agent-shim/compare/v7.5.0...v7.6.0) (2026-10-03)

### Features

* **frontdoor:** tap the control plane's stream at the byte level ([d06db3e](https://github.com/ExaDev/agent-shim/commit/d06db3eb56432a8c2b029f13edca09c0d811d1c7))

### Bug Fixes

* classify codex-quota.json, file-transfers and settings backups in the default map ([d9977a2](https://github.com/ExaDev/agent-shim/commit/d9977a280a77cfd3786bc16808e83e6aa6a7af4a))
* **frontdoor:** keep the tap ALPN list module-private ([3cb62ca](https://github.com/ExaDev/agent-shim/commit/3cb62ca6a4c9483f173519c5e42a2f95edb6d6bf))
* **frontdoor:** mirror the client's ALPN choice on a tap session's upstream ([8451039](https://github.com/ExaDev/agent-shim/commit/8451039c6462b415742fea636467d8e9d9837b4d))

### Documentation

* **frontdoor:** state the stream tap's compressed-frame caveat plainly ([1838a92](https://github.com/ExaDev/agent-shim/commit/1838a923d32060c528cfcb83c272ee5de9f74f3f))

## [7.5.0](https://github.com/ExaDev/agent-shim/compare/v7.4.0...v7.5.0) (2026-10-03)

### Features

* export the state root layout, configuration schemas and typed errors from the library ([4ab500e](https://github.com/ExaDev/agent-shim/commit/4ab500ed85c41506f9aacb5094847f4cdfe55f14))

## [7.4.0](https://github.com/ExaDev/agent-shim/compare/v7.3.0...v7.4.0) (2026-10-03)

### Features

* **frontdoor:** terminate platform.claude.com on the CONNECT surface ([d19c144](https://github.com/ExaDev/agent-shim/commit/d19c1449af517163cbc15ef1ae701f81245cba6b))

## [7.3.0](https://github.com/ExaDev/agent-shim/compare/v7.2.0...v7.3.0) (2026-10-03)

### Features

* **frontdoor:** decide capture from the environment in one testable place ([ce0323b](https://github.com/ExaDev/agent-shim/commit/ce0323b9797cd2fc0a44356b56a491d542517120))

### Bug Fixes

* **frontdoor:** keep the capture env constant module-private ([8688cc7](https://github.com/ExaDev/agent-shim/commit/8688cc735cd2a424faf7519f01488ffb82d016c1))

### Documentation

* name the Keychain credential hash's derivation from the farm path ([9c3ae92](https://github.com/ExaDev/agent-shim/commit/9c3ae927303683babeb18818acfaed763416ae16))

## [7.2.0](https://github.com/ExaDev/agent-shim/compare/v7.1.3...v7.2.0) (2026-10-03)

### Features

* **frontdoor:** capture the CONNECT surface's targets and piped exchanges ([fc1ae12](https://github.com/ExaDev/agent-shim/commit/fc1ae124eefd6867e96e303312f9db7b1849c45b))

### Continuous Integration

* keep the Scoop claude-use manifest tracking releases ([bdd8c59](https://github.com/ExaDev/agent-shim/commit/bdd8c592b78a6fd3a644a500a03e916afb6d7120))

## [7.1.3](https://github.com/ExaDev/agent-shim/compare/v7.1.2...v7.1.3) (2026-10-03)

### Documentation

* note that sessions launched under the former name still reach the front door ([24dcd4c](https://github.com/ExaDev/agent-shim/commit/24dcd4ce115469360e574fbdd1cb299f81b4be9c))

## [7.1.2](https://github.com/ExaDev/agent-shim/compare/v7.1.1...v7.1.2) (2026-10-03)

### Bug Fixes

* **frontdoor:** accept the former x-claude-use-* wire headers ([43cbf2d](https://github.com/ExaDev/agent-shim/commit/43cbf2d6a6b06e5ebe0ff0bb777672df9a97640c))
* keep the wire header prefixes module-private ([b77a9f5](https://github.com/ExaDev/agent-shim/commit/b77a9f5fad52804773d9db7d1cbe01e0ca93fb6f))

### Continuous Integration

* release on more commit types and list them in the changelog ([d96f218](https://github.com/ExaDev/agent-shim/commit/d96f2184b693197112fdefa3ccc759dcbeca7cd7))

## [7.1.1](https://github.com/ExaDev/agent-shim/compare/v7.1.0...v7.1.1) (2026-10-03)

### Bug Fixes

* **frontdoor:** keep the provider base URL's path when forwarding ([c88b3ce](https://github.com/ExaDev/agent-shim/commit/c88b3ce2297281424e894e5132249d2e411d8dc4))

## [7.1.0](https://github.com/ExaDev/agent-shim/compare/v7.0.0...v7.1.0) (2026-10-03)

### Features

* publish the build to npm under the former claude-use name too ([573a137](https://github.com/ExaDev/agent-shim/commit/573a137c497bd75c56d71911ee6d8a42e287e9d2))

## [7.0.0](https://github.com/ExaDev/agent-shim/compare/v6.2.3...v7.0.0) (2026-10-03)

### ⚠ BREAKING CHANGES

* a configuration that relied on all: true opening runtime must now set
  runtime: true as well.
* the npm package is now agent-shim, and release assets, the Homebrew formula and
  the Scoop manifest are named agent-shim-*.

### Features

* rename claude-use to agent-shim ([3d6df09](https://github.com/ExaDev/agent-shim/commit/3d6df091620e5272c7f517dce1d284f50cd601ac))

### Bug Fixes

* keep runtime closed under the all category shorthand ([af43da1](https://github.com/ExaDev/agent-shim/commit/af43da11787fef659268cd400af6b11a3917fe73))

## [6.2.3](https://github.com/ExaDev/claude-use/compare/v6.2.2...v6.2.3) (2026-10-03)

### Bug Fixes

* **headroom:** verify the installed commit against a pinned source ([f0535da](https://github.com/ExaDev/claude-use/commit/f0535da5280026b826229e588f4deb544fed708a))
* **headroom:** write state.json atomically ([79601fb](https://github.com/ExaDev/claude-use/commit/79601fbf26cfc09e798b99df54542522ceacef5b))

## [6.2.2](https://github.com/ExaDev/claude-use/compare/v6.2.1...v6.2.2) (2026-10-03)

### Bug Fixes

* **headroom:** pin the default install source to the streaming passthrough build ([7411860](https://github.com/ExaDev/claude-use/commit/7411860503850ec9183e7e96af2058cd671e36a8))

## [6.2.1](https://github.com/ExaDev/claude-use/compare/v6.2.0...v6.2.1) (2026-10-03)

### Bug Fixes

* **headroom:** scope sessions and state writes to the owning supervisor ([db32d8a](https://github.com/ExaDev/claude-use/commit/db32d8a69a71a9abf454fbdcf6e17d2b994c467c))

## [6.2.0](https://github.com/ExaDev/claude-use/compare/v6.1.0...v6.2.0) (2026-10-02)

### Features

* **check:** report the member a pool selection would pick ([3b07160](https://github.com/ExaDev/claude-use/commit/3b07160d144494613d1bf21b6701dbebc55be019))
* **config:** pools and the pool selector for identity choice ([070a78c](https://github.com/ExaDev/claude-use/commit/070a78cae7663cb45ddf025627302cf0b604e3b3))
* **config:** publish the pools and selector schemas ([fd89a12](https://github.com/ExaDev/claude-use/commit/fd89a12ae394a7bd7ed18fbe0dce0d5da292214e))
* **doctor:** audit pools and pool selectors in rules and the active-identity file ([e15799c](https://github.com/ExaDev/claude-use/commit/e15799c8e6ef168255b6a7058c711921f75c7d23))
* **launcher:** resolve a pool selector to one member at launch ([d441e91](https://github.com/ExaDev/claude-use/commit/d441e91168d76a2ce73088e7c913b4baef8e8c5c))
* **pool:** add the pool command noun with add, set, list, show, remove, use and pick ([6eb4d42](https://github.com/ExaDev/claude-use/commit/6eb4d42ac42198e9dd97a181dc437429fece63ed))
* **usage:** rank pool members by plan-weighted quota expiring soonest ([4adb7a7](https://github.com/ExaDev/claude-use/commit/4adb7a7fb5aad39420e214bc4bcf950f3e4a175a))
* **usage:** rank pool members from the usage store and remember the last pick per directory ([a19422c](https://github.com/ExaDev/claude-use/commit/a19422c11c368a96d10812f9890114459258a754))

## [6.1.0](https://github.com/ExaDev/claude-use/compare/v6.0.0...v6.1.0) (2026-10-02)

### Features

* **launcher:** opt-in trackUsage routes plain OAuth launches through the front door ([62f0e18](https://github.com/ExaDev/claude-use/commit/62f0e18bc5a1231f3a0fb36d171cb379fb469413))

## [6.0.0](https://github.com/ExaDev/claude-use/compare/v5.5.0...v6.0.0) (2026-10-02)

### ⚠ BREAKING CHANGES

* the npm package requires Node 22.18 or later, or 24 and above.

### Build System

* require Node 22.18 or later, and take cosmiconfig 10 ([cd739d0](https://github.com/ExaDev/claude-use/commit/cd739d0a8a1b97709d7089a2aa78be2c229fd631))

## [5.5.0](https://github.com/ExaDev/claude-use/compare/v5.4.1...v5.5.0) (2026-10-02)

### Features

* **usage:** pull OpenRouter's key, credit and free-model quota into the snapshot ([b272fdd](https://github.com/ExaDev/claude-use/commit/b272fddaad5dd40a3de8eca39913060463467ff4))
* **usage:** pull z.ai's quota from its usage endpoint into the snapshot ([c683bbe](https://github.com/ExaDev/claude-use/commit/c683bbeb2268d37efc9c979fedc27f443f88db76))

## [5.4.1](https://github.com/ExaDev/claude-use/compare/v5.4.0...v5.4.1) (2026-10-02)

### Bug Fixes

* **install:** install the latest GitHub release's exact version on macOS x64 ([e621f5a](https://github.com/ExaDev/claude-use/commit/e621f5ae1181edbdd3f7d88fc3f760b7dd6b483c))

## [5.4.0](https://github.com/ExaDev/claude-use/compare/v5.3.0...v5.4.0) (2026-10-02)

### Features

* **launcher:** warn at launch when the identity's recorded quota window is nearly used ([9172891](https://github.com/ExaDev/claude-use/commit/9172891884cdbfd2ef6252e44d452d99d2f6fd06))

## [5.3.0](https://github.com/ExaDev/claude-use/compare/v5.2.0...v5.3.0) (2026-10-02)

### Features

* **usage:** publish the usage snapshot schema and export its reader ([2761436](https://github.com/ExaDev/claude-use/commit/2761436bb0c6e73e9ed15a550be29bcd980557a7))

## [5.2.0](https://github.com/ExaDev/claude-use/compare/v5.1.1...v5.2.0) (2026-10-02)

### Features

* **frontdoor:** let response middleware follow the body and see the request ([28066cc](https://github.com/ExaDev/claude-use/commit/28066cc144c7297b686be020f52e618591d35609))
* **fs:** append to an owner-only file without ever widening its mode ([85fe839](https://github.com/ExaDev/claude-use/commit/85fe8395e17a07549a682921c79d1f983e1bb158))
* **usage:** record per-identity usage and quota in the front door ([cf83ceb](https://github.com/ExaDev/claude-use/commit/cf83ceb3a93a46f9b054307d18ee20efce649ba1)), references [#53](https://github.com/ExaDev/claude-use/issues/53)

## [5.1.1](https://github.com/ExaDev/claude-use/compare/v5.1.0...v5.1.1) (2026-10-02)

### Bug Fixes

* **build:** declare the node types the declaration build relies on ([82e7814](https://github.com/ExaDev/claude-use/commit/82e78144e53520b9fd8f7410d0ff3c9f7a1a5a0f))

## [5.1.0](https://github.com/ExaDev/claude-use/compare/v5.0.1...v5.1.0) (2026-10-01)

### Features

* **headroom:** configurable token-saving settings in the global headroom block ([2581a81](https://github.com/ExaDev/claude-use/commit/2581a812a7d3f8fa840d7a0396ef20063e6ac407)), closes [#58](https://github.com/ExaDev/claude-use/issues/58)

## [5.0.1](https://github.com/ExaDev/claude-use/compare/v5.0.0...v5.0.1) (2026-10-01)

### Bug Fixes

* **launcher:** exempt loopback from an inherited proxy for provider launches ([753c715](https://github.com/ExaDev/claude-use/commit/753c715ab0b92c6fdf1a2945c7574b0df760ed29)), closes [#64](https://github.com/ExaDev/claude-use/issues/64)

## [5.0.0](https://github.com/ExaDev/claude-use/compare/v4.5.0...v5.0.0) (2026-10-01)

### ⚠ BREAKING CHANGES

* **library:** the library no longer exports startMitmServer,
  realMitmEffects, realMitmCertStore, MITM_INTERCEPT_HOST,
  HEADROOM_SERVED_PATH_PREFIX, servedByHeadroom or the Mitm* types.
  Use startConnectServer, realConnectEffects, realConnectCertStore,
  CONNECT_INTERCEPT_HOST, ROUTED_PATH_PREFIX, servedByPipeline and the
  Connect* types. The CONNECT server now requires a launch capability
  on every request and takes ConnectServerConfig, which differs from
  MitmServerConfig.

### Features

* **frontdoor:** apply the headroom hop and pass every provider through the door ([bf083bd](https://github.com/ExaDev/claude-use/commit/bf083bdda5b6c52277b6af887b3963ba679a3cd2))
* **launcher:** route every provider and headroom session through the front door ([9b28919](https://github.com/ExaDev/claude-use/commit/9b2891959684d81757ca836ef5548d6cba0a5cb1))
* **library:** export the front door's CONNECT surface and lifecycle ([b7fdb36](https://github.com/ExaDev/claude-use/commit/b7fdb36504a357d644ca1f5ce724e31fbe0dcea8))

### Bug Fixes

* **frontdoor:** authenticate every CONNECT and bound the surface's connections ([a133609](https://github.com/ExaDev/claude-use/commit/a13360935e942d9fc2a62fa2d4a955ae5be45a06)), closes [#63](https://github.com/ExaDev/claude-use/issues/63)
* **frontdoor:** authenticate the door to the child before it sends credentials ([52c1acb](https://github.com/ExaDev/claude-use/commit/52c1acb320300ba6e8d7c993f74af13683ea1275))
* **frontdoor:** bound the listener probe against a silent squatter ([abbb5c2](https://github.com/ExaDev/claude-use/commit/abbb5c265c86ad55fecf3fd87ede947f687cb6ce))
* **frontdoor:** keep provider credentials out of the headroom hop ([9caad5a](https://github.com/ExaDev/claude-use/commit/9caad5acf74d8e77ecfbf15bee77944225f8f0b3))
* **frontdoor:** keep tokenised sessions visible to the supervisor and store capabilities owner-only ([4de7e78](https://github.com/ExaDev/claude-use/commit/4de7e78efe1bde7c62ac99b731ec25b04443a8f0))
* **frontdoor:** let a listener move off an occupied sticky port ([4198705](https://github.com/ExaDev/claude-use/commit/4198705ee58577e77bdf7238c59e65fe97f2b516))
* **frontdoor:** own headroom's per-request upstream header and serve bare /v1/ targets ([5cb4277](https://github.com/ExaDev/claude-use/commit/5cb42775f9570147c08899f89596e9ba85fb1b15))
* **frontdoor:** require a per-launch capability before routing anything ([6a86d91](https://github.com/ExaDev/claude-use/commit/6a86d91cd28fadcb8fed522b934b73ea2b4a20a1))
* **frontdoor:** strip hop-by-hop headers from forwarded responses ([8931913](https://github.com/ExaDev/claude-use/commit/8931913df24b128a735811c155f58d6a2ceaafcc))

### Performance Improvements

* **frontdoor:** cache pass-through routes so their connection pools persist ([3d85d57](https://github.com/ExaDev/claude-use/commit/3d85d5794041a653aad60272b72325cd9193921e))

## [4.5.0](https://github.com/ExaDev/claude-use/compare/v4.4.0...v4.5.0) (2026-10-01)

### Features

* publish a library export surface alongside the CLI binary ([16a87c6](https://github.com/ExaDev/claude-use/commit/16a87c6329fa5cacd3fe212c689839bc860021b5)), references [#37](https://github.com/ExaDev/claude-use/issues/37)

## [4.4.0](https://github.com/ExaDev/claude-use/compare/v4.3.0...v4.4.0) (2026-10-01)

### Features

* **credential:** cache resolved credentials with a ttl and a chosen store ([2742e2e](https://github.com/ExaDev/claude-use/commit/2742e2e76048d9599ca48c230fa18e20c5369a90)), references [#46](https://github.com/ExaDev/claude-use/issues/46)

## [4.3.0](https://github.com/ExaDev/claude-use/compare/v4.2.1...v4.3.0) (2026-10-01)

### Features

* **credential:** store a setup-token token for an identity ([5b8b403](https://github.com/ExaDev/claude-use/commit/5b8b403f1ec6c365a36f75aca2bb03508acba832)), references [#45](https://github.com/ExaDev/claude-use/issues/45)

## [4.2.1](https://github.com/ExaDev/claude-use/compare/v4.2.0...v4.2.1) (2026-10-01)

### Bug Fixes

* **headroom:** pin the default install source to a commit and warn on moving git refs ([ecc4cdc](https://github.com/ExaDev/claude-use/commit/ecc4cdc6fbe1a1383138336ceb633b436be8824a)), closes [#54](https://github.com/ExaDev/claude-use/issues/54)

## [4.2.0](https://github.com/ExaDev/claude-use/compare/v4.1.0...v4.2.0) (2026-09-30)

### Features

* **frontdoor:** add the front-door daemon with its ordered routing pipeline ([db7ca79](https://github.com/ExaDev/claude-use/commit/db7ca79d610b8f10ec442884b0e9f56020c73483))
* **frontdoor:** mount the codex translation in process and retire the codex daemon ([3489832](https://github.com/ExaDev/claude-use/commit/348983294534c840e1b30a6d92abf1bafea61c8d))

## [4.1.0](https://github.com/ExaDev/claude-use/compare/v4.0.0...v4.1.0) (2026-09-30)

### Features

* add a codex provider kind served by a supervised translation daemon ([9d07d40](https://github.com/ExaDev/claude-use/commit/9d07d402046bbe52fa5a6b55f93b3ffd5ffb1a61))

## [4.0.0](https://github.com/ExaDev/claude-use/compare/v3.0.0...v4.0.0) (2026-09-30)

### ⚠ BREAKING CHANGES

* provider files no longer accept tokenEnv, tokenCommand,
  authScheme or a credential variable in env; use a credential block instead.
  A file still in the old format is refused with its exact replacement, and the
  --token-env, --token-command and --auth-scheme options are gone.

### Features

* report credentials in check and old-format providers in doctor ([eada1de](https://github.com/ExaDev/claude-use/commit/eada1de93601210551eee58b6f4a8e4f1cd3b152))
* resolve provider and identity tokens from a shared credential block ([affe491](https://github.com/ExaDev/claude-use/commit/affe4913c3ae36a2c4d0adea7be41c961498d3eb))

## [3.0.0](https://github.com/ExaDev/claude-use/compare/v2.9.0...v3.0.0) (2026-09-30)

### ⚠ BREAKING CHANGES

* rules is now rule, and rule add no longer updates an
  existing rule (use rule set). profile create, wizard and set-default
  are profile add, set and use. identity set-default-profile is identity
  set --default-profile, and identity resolve is identity
  resolve-conflicts. configure takes --identity instead of a positional
  identity. rules add --profile is rule add --config-profile.
  profile set --skip-permissions, --remote-control and --headroom are
  --launch-skip-permissions, --launch-remote-control and
  --launch-headroom. CLAUDE_ACCOUNT is CLAUDE_USE_IDENTITY. --category,
  --entry, --share, --hide and --extends take one value per occurrence
  instead of a comma list. A launch naming a missing identity or
  configuration profile now exits 1.

### Features

* one command grammar, flag spelling and error path for claude-use ([ecbc90a](https://github.com/ExaDev/claude-use/commit/ecbc90a94d41cc9c3813bf80a6f1aeb794ba9cf4))

## [2.9.0](https://github.com/ExaDev/claude-use/compare/v2.8.0...v2.9.0) (2026-09-30)

### Features

* **providers:** token commands and API key auth scheme ([ce730bb](https://github.com/ExaDev/claude-use/commit/ce730bb8343c804a50cb571d799eca51e915bfb7))

### Bug Fixes

* default the supervised headroom proxy to HTTP/1.1 upstream ([ad9f837](https://github.com/ExaDev/claude-use/commit/ad9f8379cf6d13b9740e02664207f3d80d1cde17))

## [2.8.0](https://github.com/ExaDev/claude-use/compare/v2.7.0...v2.8.0) (2026-09-27)

### Features

* add --headroom/--no-headroom one-off launch flags ([94e1a2c](https://github.com/ExaDev/claude-use/commit/94e1a2cf29daec32df1aaefcfb9b40ccd96b0f6c))

## [2.7.0](https://github.com/ExaDev/claude-use/compare/v2.6.0...v2.7.0) (2026-09-27)

### Features

* route OAuth sessions through a TLS-terminating MITM proxy for headroom ([48ce107](https://github.com/ExaDev/claude-use/commit/48ce1070837fc7a6f9c087635a2e874c1e10e8a0))

## [2.6.0](https://github.com/ExaDev/claude-use/compare/v2.5.4...v2.6.0) (2026-09-27)

### Features

* allow a provider to carry a fixed credential instead of tokenEnv ([5598e3c](https://github.com/ExaDev/claude-use/commit/5598e3ca7098605bc773ec96e622a2ebfed0f8e3))

## [2.5.4](https://github.com/ExaDev/claude-use/compare/v2.5.3...v2.5.4) (2026-09-27)

### Bug Fixes

* keep the headroom daemon's port stable across restarts ([bb7da4f](https://github.com/ExaDev/claude-use/commit/bb7da4f385478920eefd9f5b6013a55332e38621))

## [2.5.3](https://github.com/ExaDev/claude-use/compare/v2.5.2...v2.5.3) (2026-09-27)

### Bug Fixes

* reap the headroom proxy and read zombie pids as dead ([e31eb21](https://github.com/ExaDev/claude-use/commit/e31eb217c1afa47c8828e6abc60575761aa5530b))
* treat a zombie identity-lock holder as dead ([72ff6f2](https://github.com/ExaDev/claude-use/commit/72ff6f2e2caf7e068c175a55be79ad9fc96c2467))

## [2.5.2](https://github.com/ExaDev/claude-use/compare/v2.5.1...v2.5.2) (2026-09-27)

### Bug Fixes

* name the headroom distribution correctly in the default install spec ([a6167cd](https://github.com/ExaDev/claude-use/commit/a6167cd63809251877f06a1ad827d7a4f3675fa2))
* pin the headroom source to the per-session-savings branch ([10be19c](https://github.com/ExaDev/claude-use/commit/10be19c1a164ad52cefee0b05250b7bf1bab5ca6))

## [2.5.1](https://github.com/ExaDev/claude-use/compare/v2.5.0...v2.5.1) (2026-09-27)

### Bug Fixes

* resolve launch flags from the cascade on escape-hatch launches ([98e7e48](https://github.com/ExaDev/claude-use/commit/98e7e48020fe5872c5c6eba23f4d76372ea1a6bf))

## [2.5.0](https://github.com/ExaDev/claude-use/compare/v2.4.2...v2.5.0) (2026-09-27)

### Features

* route launches through a supervised headroom daemon ([47912fd](https://github.com/ExaDev/claude-use/commit/47912fd1783984435e33ac0ba3220d4af805dcf7))
* route launches through named API providers ([9d41cb6](https://github.com/ExaDev/claude-use/commit/9d41cb606add2eeb835f3d50194209c6f1354338))

## [2.4.2](https://github.com/ExaDev/claude-use/compare/v2.4.1...v2.4.2) (2026-09-17)

### Bug Fixes

* preserve literal -- when forwarding args in claude-use run ([f046c44](https://github.com/ExaDev/claude-use/commit/f046c44cea02bf7137395f81ac92390f814dded8))

## [2.4.1](https://github.com/ExaDev/claude-use/compare/v2.4.0...v2.4.1) (2026-09-14)

### Bug Fixes

* **lint:** resolve @exadev/eslint-config fallout in cli/claudeShim ([8307bf1](https://github.com/ExaDev/claude-use/commit/8307bf1a490d656a924a63f1c21e4cfcf250aaa7))
* **lint:** resolve @exadev/eslint-config fallout in configure/rules ([a4baf9d](https://github.com/ExaDev/claude-use/commit/a4baf9d02178b8235eab1758790305028210a432))
* **lint:** resolve @exadev/eslint-config fallout in doctor/identity ([8beeff5](https://github.com/ExaDev/claude-use/commit/8beeff52ac758d2feb69451765245fcdf95cf88e))
* **lint:** resolve @exadev/eslint-config fallout in remaining src/* ([81dbd90](https://github.com/ExaDev/claude-use/commit/81dbd9077ed7592094e0d0be931df4f32158f927))
* **lint:** resolve @exadev/eslint-config fallout in scripts/release config ([ff353d8](https://github.com/ExaDev/claude-use/commit/ff353d8ecb41fe5fd40567253b8be9a25871f8c6))
* **lint:** resolve @exadev/eslint-config fallout in src/config ([17a0c36](https://github.com/ExaDev/claude-use/commit/17a0c360e3ea70fa5c7434d3b65a113390e68273))
* **lint:** resolve @exadev/eslint-config fallout in src/launcher ([81fe0a8](https://github.com/ExaDev/claude-use/commit/81fe0a84589e2cd1be051461039944a8710eb709))
* **lint:** resolve @exadev/eslint-config fallout in src/resolve ([98a7e67](https://github.com/ExaDev/claude-use/commit/98a7e6777e812136b5408ce73294a453c6f80f8a))
* repair NUL-byte corruption in dedupeDiagnostics's key template ([341185d](https://github.com/ExaDev/claude-use/commit/341185d5547fb2b9b7a9a549c0f8078a08c7177a))

## [2.4.0](https://github.com/ExaDev/claude-use/compare/v2.3.1...v2.4.0) (2026-09-12)

### Features

* default the new-identity wizard's profile prompt to skip ([eb2faf8](https://github.com/ExaDev/claude-use/commit/eb2faf80c2b8a8b5532f96c6d1d228086c31a0f3))

## [2.3.1](https://github.com/ExaDev/claude-use/compare/v2.3.0...v2.3.1) (2026-09-12)

### Bug Fixes

* retry the npm tarball fetch long enough to survive real propagation lag ([579b7b2](https://github.com/ExaDev/claude-use/commit/579b7b24c158d5b59f95b5e87f194a4c6f1fe58f))

## [2.3.0](https://github.com/ExaDev/claude-use/compare/v2.2.0...v2.3.0) (2026-09-12)

### Features

* auto-resolve a runtime-category farm collision instead of asking ([3b7d3ee](https://github.com/ExaDev/claude-use/commit/3b7d3ee4fc1a282ffb21c36d934067ac35746701))

## [2.2.0](https://github.com/ExaDev/claude-use/compare/v2.1.0...v2.2.0) (2026-09-12)

### Features

* report which claude-use a bare command name actually resolves to ([75ae588](https://github.com/ExaDev/claude-use/commit/75ae58806d710212a485d42b133eb94eb1bcc050))

### Bug Fixes

* keep listing identities when one identity.json cannot be read ([d863334](https://github.com/ExaDev/claude-use/commit/d863334d73afdd8c93a2776c4076dd9e8e6959bc))

## [2.1.0](https://github.com/ExaDev/claude-use/compare/v2.0.4...v2.1.0) (2026-09-11)

### Features

* allow @ in the body of identity and profile names ([838b99c](https://github.com/ExaDev/claude-use/commit/838b99c79fd5614fcd8149cd9c23f39e453c64d4))

## [2.0.4](https://github.com/ExaDev/claude-use/compare/v2.0.3...v2.0.4) (2026-09-11)

### Bug Fixes

* reject an invalid identity name before offering the creation wizard ([91442d0](https://github.com/ExaDev/claude-use/commit/91442d04b02f2dfe00eb2a39e5244ef29659ff95))

## [2.0.3](https://github.com/ExaDev/claude-use/compare/v2.0.2...v2.0.3) (2026-09-11)

### Bug Fixes

* refresh dependencies to clear the five high and two moderate audit advisories ([219e0a3](https://github.com/ExaDev/claude-use/commit/219e0a3d4fdb5ddb3fa58fa7c0d1c9de8da2b792))

## [2.0.2](https://github.com/ExaDev/claude-use/compare/v2.0.1...v2.0.2) (2026-08-21)

### Bug Fixes

* convert createProfile's raw ZodError throw into ConfigValidationError ([423eddf](https://github.com/ExaDev/claude-use/commit/423eddfa17d41b0f94c0283fc2ddf713882ea302))
* convert directoryRules' raw parse/Error throws into CliError subclasses ([74cfe16](https://github.com/ExaDev/claude-use/commit/74cfe160d861eab7fa2293eff990b3db5384e24f))

## [2.0.1](https://github.com/ExaDev/claude-use/compare/v2.0.0...v2.0.1) (2026-08-21)

### Bug Fixes

* convert addIdentity's Zod validation failure into a CliError ([d03712a](https://github.com/ExaDev/claude-use/commit/d03712a04cf5f4ed3486f81c8ab6e765cf3a0b5b))

## [2.0.0](https://github.com/ExaDev/claude-use/compare/v1.5.0...v2.0.0) (2026-08-19)

### ⚠ BREAKING CHANGES

* history (projects, sessions, session-env, teams, tasks,
  todos, history.jsonl, transcripts, paste-cache, file-history, plans,
  workflows, jobs, debug, downloads, chrome) is now shared between identities
  by default. Anyone relying on the old closed-by-default behaviour for
  confidentiality between identities must now set categories.history=false
  explicitly, via a configuration profile, directory rule, or
  ~/.claude-use/config.json's global categories override.

### Features

* share history by default, isolating identities on credentials alone ([bc8a9bd](https://github.com/ExaDev/claude-use/commit/bc8a9bdab232fb4c68612f380360dc4e850a6ec9))

### Bug Fixes

* override nanoid to ^3.3.18 to clear GHSA-2v37-7h3g-55p8 ([114a8dc](https://github.com/ExaDev/claude-use/commit/114a8dc0a7df52eb07ae0b001f5627761916d1e0))

## [1.5.0](https://github.com/ExaDev/claude-use/compare/v1.4.0...v1.5.0) (2026-08-07)

### Features

* offer an identity setup wizard when [@name](https://github.com/name) targets a missing identity ([62c5819](https://github.com/ExaDev/claude-use/commit/62c5819cafaa24bbe5f1cdc711b336225413a0ab))

### Bug Fixes

* override js-yaml to ^4.3.1 to clear CVE-2026-59870 ([57eede9](https://github.com/ExaDev/claude-use/commit/57eede98d06f30e74bcd3051a77105bd276455e1))

## [1.4.0](https://github.com/ExaDev/claude-use/compare/v1.3.2...v1.4.0) (2026-08-06)

### Features

* add a unified profile wizard and offer it when a profile is missing ([218f531](https://github.com/ExaDev/claude-use/commit/218f53154334fa9921638f7b0a966b09906bedf5))

## [1.3.2](https://github.com/ExaDev/claude-use/compare/v1.3.1...v1.3.2) (2026-08-06)

### Bug Fixes

* catch known errors at the top level instead of crashing with a stack trace ([e7523a6](https://github.com/ExaDev/claude-use/commit/e7523a6d019258aab4feee93ccf7f36c47492c89))

## [1.3.1](https://github.com/ExaDev/claude-use/compare/v1.3.0...v1.3.1) (2026-08-05)

### Bug Fixes

* run the PR-triggered platform build jobs even though semantic-release is skipped ([a2058d5](https://github.com/ExaDev/claude-use/commit/a2058d5ae1569654719f20d1470d00e304e78eaf)), references [#7](https://github.com/ExaDev/claude-use/issues/7)

## [1.3.0](https://github.com/ExaDev/claude-use/compare/v1.2.1...v1.3.0) (2026-08-05)

### Features

* build and smoke test each platform binary on pull requests ([7c297b3](https://github.com/ExaDev/claude-use/commit/7c297b3de25c0cef073b8c41af495f39f91241fb))

## [1.2.1](https://github.com/ExaDev/claude-use/compare/v1.2.0...v1.2.1) (2026-08-05)

### Bug Fixes

* scope the shared Turbo cache key by runner architecture, not just OS ([7e43b7f](https://github.com/ExaDev/claude-use/commit/7e43b7f7e80e06a80f82ad452c1639ec249608ce))

## [1.2.0](https://github.com/ExaDev/claude-use/compare/v1.1.0...v1.2.0) (2026-08-05)

### Features

* build the bundle in prepare so a git-based install actually works ([f9166d5](https://github.com/ExaDev/claude-use/commit/f9166d5b148a8a4c978811557b5ec38e5add82af))

## [1.1.0](https://github.com/ExaDev/claude-use/compare/v1.0.0...v1.1.0) (2026-08-05)

### Features

* publish claude-use as @exadev/claude-use to GitHub Packages ([aa9d5bc](https://github.com/ExaDev/claude-use/commit/aa9d5bcb32451df86a039d46f9f431f9f2bf5794))

## [1.0.0](https://github.com/ExaDev/claude-use/compare/v0.6.0...v1.0.0) (2026-08-05)

### ⚠ BREAKING CHANGES

* none -- this commit changes no behavior. It marks the
  existing CLI and configuration surface as the v1.0 stable public API,
  triggering the major version bump to reflect that commitment.

### Miscellaneous Chores

* declare the public API stable at v1.0.0 ([1213ae2](https://github.com/ExaDev/claude-use/commit/1213ae2c26a8e5b0e5a73aa8c5a490542d4de1a8))

## [0.6.0](https://github.com/ExaDev/claude-use/compare/v0.5.0...v0.6.0) (2026-08-05)

### Features

* add claude-use identity resolve for interactive farm-conflict resolution ([7fb1095](https://github.com/ExaDev/claude-use/commit/7fb10955a7e340a97be5873b2ff8e7b020ea680d))

## [0.5.0](https://github.com/ExaDev/claude-use/compare/v0.4.0...v0.5.0) (2026-08-04)

### Features

* add a claude-use @<name> shortcut for identity use <name> ([28868bd](https://github.com/ExaDev/claude-use/commit/28868bd88821d381a8958d5db77368887ecfad2a))

## [0.4.0](https://github.com/ExaDev/claude-use/compare/v0.3.6...v0.4.0) (2026-08-04)

### Features

* add an 'all' shorthand for every overridable category ([4ad3a96](https://github.com/ExaDev/claude-use/commit/4ad3a96a23a0bfb5e549448d4bfb1f1607aec191))

## [0.3.6](https://github.com/ExaDev/claude-use/compare/v0.3.3...v0.3.6) (2026-08-03)

v0.3.4 and v0.3.5 were tagged but never fully published — a CI concurrency race cancelled their release pipelines mid-flight (fixed below), and both tags/releases have been removed. v0.3.6 is the first version to actually ship the fixes below.

### Bug Fixes

* make the Turbo cache key unique per CI run ([660fd3d](https://github.com/ExaDev/claude-use/commit/660fd3d46bbe25bf28722520cb53fa2db7dc299e))
* don't cancel an in-flight release when a push supersedes it ([5ee1f30](https://github.com/ExaDev/claude-use/commit/5ee1f30acd56c4830ca14110c5e414bdb7c42898))
* stop trying to override the reserved GITHUB_REF_NAME variable ([e14e733](https://github.com/ExaDev/claude-use/commit/e14e73302861f684ec82195f29baf523a6bc6f57))

## [0.3.3](https://github.com/ExaDev/claude-use/compare/v0.3.2...v0.3.3) (2026-08-03)

### Bug Fixes

* override conventional-changelog-writer to fix empty changelog notes ([47e787b](https://github.com/ExaDev/claude-use/commit/47e787bdb161bfb865d524519fc8d3bc138e6940))

## [0.3.2](https://github.com/ExaDev/claude-use/compare/v0.3.1...v0.3.2) (2026-08-03)

### Bug Fixes

* re-dispatch CI against the new tag instead of relying on its push event ([b19a5ba](https://github.com/ExaDev/claude-use/commit/b19a5bac5a35c83e6fb9e36a33cfe703e90a2e98))

## [0.3.1](https://github.com/ExaDev/claude-use/compare/v0.3.0...v0.3.1) (2026-08-02)

### Bug Fixes

* point semantic-release at the SSH remote so it uses the deploy key ([ec9ff49](https://github.com/ExaDev/claude-use/commit/ec9ff49cceef95888cf2ee0de8f3453aeb72c666))
* use a deploy key so semantic-release's tag push triggers the release pipeline ([c11cda3](https://github.com/ExaDev/claude-use/commit/c11cda35cc1dbd621de8796fec18bfd952620140))

## [0.3.0](https://github.com/ExaDev/claude-use/compare/v0.2.10...v0.3.0) (2026-08-02)

### Features

* automate version decisions and changelog via semantic-release ([bb1b8a3](https://github.com/ExaDev/claude-use/commit/bb1b8a3bec0f99ff2300e843618002c95000fbea))

## [0.2.10](https://github.com/ExaDev/claude-use/compare/v0.2.9...v0.2.10) (2026-08-02)

### Bug Fixes

* install macOS x64 via npm in install.sh too, matching Homebrew ([0eb58aa](https://github.com/ExaDev/claude-use/commit/0eb58aa084f0c0feb3d4d0f849bd78b778fb573b)), references [nodejs/node#62893](https://github.com/nodejs/node/issues/62893) [#59553](https://github.com/ExaDev/claude-use/issues/59553)

## [0.2.9](https://github.com/ExaDev/claude-use/compare/v0.2.8...v0.2.9) (2026-08-02)

### Bug Fixes

* install macOS x64 Homebrew via npm instead of the broken SEA binary ([6f2f406](https://github.com/ExaDev/claude-use/commit/6f2f4068dbc9743df8d0c5528c6eabe1d416fe51)), references [nodejs/node#62893](https://github.com/nodejs/node/issues/62893) [nodejs/node#59553](https://github.com/nodejs/node/issues/59553)

## [0.2.8](https://github.com/ExaDev/claude-use/compare/v0.2.7...v0.2.8) (2026-08-02)

## [0.2.7](https://github.com/ExaDev/claude-use/compare/v0.2.6...v0.2.7) (2026-08-02)

## [0.2.6](https://github.com/ExaDev/claude-use/compare/v0.2.5...v0.2.6) (2026-08-02)

### Bug Fixes

* recognise claude.exe when dispatching launcher vs CLI mode ([7766b26](https://github.com/ExaDev/claude-use/commit/7766b260cbaad4333a17ccf0e1e2a2c92f10ab6c))

## [0.2.5](https://github.com/ExaDev/claude-use/compare/v0.2.4...v0.2.5) (2026-08-02)

## [0.2.4](https://github.com/ExaDev/claude-use/compare/v0.2.3...v0.2.4) (2026-08-02)

### Bug Fixes

* hardlink the real running binary, not a PATH-visible proxy ([1a743bc](https://github.com/ExaDev/claude-use/commit/1a743bc7a251755ce1bf0549096ebeed3beb16f6))

## [0.2.3](https://github.com/ExaDev/claude-use/compare/v0.2.2...v0.2.3) (2026-08-02)

### Bug Fixes

* use PATHEXT extension matching, not mode bits, on Windows ([5bb9ccd](https://github.com/ExaDev/claude-use/commit/5bb9ccdcfe60bc55e54ff2b15377eea1e889061e))

## [0.2.2](https://github.com/ExaDev/claude-use/compare/v0.2.1...v0.2.2) (2026-08-02)

### Bug Fixes

* redirect shim placement when invoked through a re-exec wrapper ([daffb25](https://github.com/ExaDev/claude-use/commit/daffb259c1d8a27c5a2842047523c7e213d6f141))

## [0.2.1](https://github.com/ExaDev/claude-use/compare/v0.2.0...v0.2.1) (2026-08-01)

### Bug Fixes

* resolve own executable path via PATH search, not raw argv[1] ([7bd14c6](https://github.com/ExaDev/claude-use/commit/7bd14c62e44e31c8eee48f693fd762904d672283))

## [0.2.0](https://github.com/ExaDev/claude-use/compare/v0.1.1...v0.2.0) (2026-08-01)

### Features

* add claude-use doctor, a whole-tree config-graph audit ([e770287](https://github.com/ExaDev/claude-use/commit/e770287fa94d31977330d69ac096daa3d8e33013))
* add claude-use shim enable/disable ([b97d65d](https://github.com/ExaDev/claude-use/commit/b97d65d8efefe7b5903ae478caf51c80f921666f))
* **cli:** add claude-use run to reach the launcher without a claude binary ([3759744](https://github.com/ExaDev/claude-use/commit/3759744edeb69efd281f17c2621945c96033b06e))
* **paths:** add claude-shim.json to LayoutPaths ([bc92e8b](https://github.com/ExaDev/claude-use/commit/bc92e8bdb6cc93c5d1668c2b223187f27024b97a))
* wire claude-use shim into cli.ts and doctor.ts ([6c8c023](https://github.com/ExaDev/claude-use/commit/6c8c0239c6df2f6c776e2e23a7273dd31c372229))

### Bug Fixes

* **build:** replace error cast with a type guard, preserve the cause ([2c68c9e](https://github.com/ExaDev/claude-use/commit/2c68c9e0e00353a640adf6769bf69621f449a081))
* **claudeShim:** place the shim next to the executable as invoked ([4752261](https://github.com/ExaDev/claude-use/commit/4752261f423dbf9c01378d719aeda981a2b174ba))
* **config:** replace type assertions with guards and narrower types ([2511000](https://github.com/ExaDev/claude-use/commit/2511000cc126ef382d3735bcac8e758a19f4c293))
* **configure:** verify clack results instead of casting them back to Value ([f95e109](https://github.com/ExaDev/claude-use/commit/f95e10992bef14a1e38e2630cd7d92e657773003))
* drop claude from the npm package's bin field ([ab1e9a7](https://github.com/ExaDev/claude-use/commit/ab1e9a7167a4c6e0e5a63a57ce9a3c071123153b))
* **launcher:** remove redundant casts and empty fake lock sleeps ([1c3cb42](https://github.com/ExaDev/claude-use/commit/1c3cb42e96c4e7256a5d065a0de19c6f0879f27b))
* remove redundant casts in realPorts and directoryRules ([5010709](https://github.com/ExaDev/claude-use/commit/5010709cbb0b82945e5537a32adbd8010a91446e))
* **resolve:** drop unused imports, a stale cast, and a dead assignment ([6405a07](https://github.com/ExaDev/claude-use/commit/6405a07d22336a40615b6d1fdca0411d1a0d569b))

## [0.1.1](https://github.com/ExaDev/claude-use/compare/v0.1.0...v0.1.1) (2026-08-01)

### Bug Fixes

* use the explicit npx command form to work around an npm bin-resolution bug ([4ce7f0e](https://github.com/ExaDev/claude-use/commit/4ce7f0ec1d99697cdbbfffd391d23b3d61cc1c00))

## 0.1.0 (2026-08-01)

### Features

* add a placeholder CLI entrypoint for SEA packaging proof-of-concept ([be3407e](https://github.com/ExaDev/claude-use/commit/be3407eefe09e5ce7afe5c988e8337559159e1d9))
* add CLAUDE_USE_HOME-aware path resolution ([06c0806](https://github.com/ExaDev/claude-use/commit/06c0806dcdb2306c3646bb9436c159b5faf0e371))
* add claude-use check dry-run cascade inspector ([90ced3f](https://github.com/ExaDev/claude-use/commit/90ced3fc133c334966a280624f2e2297347eeae8))
* add claude-use identity subcommands ([0d1a871](https://github.com/ExaDev/claude-use/commit/0d1a871e3f744b28e85cb295b3dd5e3a2e25caac))
* add claude-use profile subcommands ([70385fb](https://github.com/ExaDev/claude-use/commit/70385fbc8935cdd5c36fed302627a0e577d8d7ed))
* add claude-use rules subcommands ([442083d](https://github.com/ExaDev/claude-use/commit/442083de7be4c1fc0e5afa5ee4ec375cf3544050))
* add injectable launcher ports for filesystem, spawn, process, and logging ([859c401](https://github.com/ExaDev/claude-use/commit/859c401deebd39faa7573472a88f50d0648cb1ef))
* add version discovery with PATH fallback ([a7ce649](https://github.com/ExaDev/claude-use/commit/a7ce64986a14ae6af55969a99389a4cceef367d8))
* build a Node SEA binary with the stable --build-sea command ([e7db11a](https://github.com/ExaDev/claude-use/commit/e7db11a53be1a3e455925823e4807a49588c8d0d))
* build a one-off cascade override from CLI flags and env vars ([815005e](https://github.com/ExaDev/claude-use/commit/815005e80d2eb31a93f7af5688129365f6dbe202))
* build, reconcile, and atomically swap an identity's symlink farm ([7642f36](https://github.com/ExaDev/claude-use/commit/7642f36faf3ca426ec95db0dcbaecbbc26d6d390))
* classify ~/.claude entries against the shipped category map ([fecac4a](https://github.com/ExaDev/claude-use/commit/fecac4a3bdc02da882d446c6eaabad5efba75975))
* **cli:** add comma-separated key=value pair parsers ([7da1cab](https://github.com/ExaDev/claude-use/commit/7da1cab2afbc4a7a2029ec837762e12f0711e0f7))
* **config:** add atomic JSON store with read/write/patch helpers ([c2e67f8](https://github.com/ExaDev/claude-use/commit/c2e67f8ea37dc64f0dbb9cae68ecd5de853dc631))
* **configure:** add interactive claude-use configure command ([bd0d486](https://github.com/ExaDev/claude-use/commit/bd0d486cf65672b02a88c30644fb5120b03cd68b))
* decide which identity and config profile a launch resolves to ([4bce045](https://github.com/ExaDev/claude-use/commit/4bce045f0961bfa6cc470a1569279c6b7283505a))
* define Zod schemas for every claude-use configuration file ([e3aca0e](https://github.com/ExaDev/claude-use/commit/e3aca0e1e4072e79234e10629c43c4632bd0d4b3))
* detect and refuse ambient credentials that would bypass identity isolation ([bf9da22](https://github.com/ExaDev/claude-use/commit/bf9da226bf6c202451dec7d66c127e8ac60f7042))
* dispatch cli.ts to the launcher or the claude-use Commander tree ([af9377d](https://github.com/ExaDev/claude-use/commit/af9377da9271b2634b53682f9445dd86bfb4f458))
* encode real paths into ~/.claude/projects/ directory names ([d91de21](https://github.com/ExaDev/claude-use/commit/d91de212bec790e079180d7c6401dd9e021dee4c))
* expose claude-use --version via Commander ([171a46e](https://github.com/ExaDev/claude-use/commit/171a46e8acc2008886633313b48fba8ac6278254))
* expose the resolver through one facade and cover the cascade ([4c4cbda](https://github.com/ExaDev/claude-use/commit/4c4cbdaf1bd86cb2dd9a16ecd5b7fbda157d5da4))
* generate and publish JSON Schemas from Zod config schemas ([12edf2e](https://github.com/ExaDev/claude-use/commit/12edf2e5047012209d154b7bd8bfdf55f1ed01a6))
* install the built SEA binary as both claude and claude-use ([e582fa2](https://github.com/ExaDev/claude-use/commit/e582fa260f216cc41b8a0654f43d70ab832a4240))
* linearise extends graphs and assemble the directory cascade ([bcb4515](https://github.com/ExaDev/claude-use/commit/bcb45153ca86c77ebf990849f0de74247b12b1dd))
* load config files by exact path with explicit entries key ordering ([a4acf2d](https://github.com/ExaDev/claude-use/commit/a4acf2d29bbc66507b71c0f45cd1c58cd90baa5b))
* load every config file one launch's cascade is assembled from ([abd493a](https://github.com/ExaDev/claude-use/commit/abd493af80deb9cf0f998848cba0018a717742e5))
* make the esbuild bundle publishable as an npm bin package ([50771b0](https://github.com/ExaDev/claude-use/commit/50771b0398a547ae8d4f1ae46027a2441650b93b))
* orchestrate one claude launch through guard, identity, and flag resolution ([4bcdeca](https://github.com/ExaDev/claude-use/commit/4bcdeca9a3460cc836bba478c09a4de6e87c9374))
* parse --config-profile/--category/--share/--hide from launcher argv ([8577f79](https://github.com/ExaDev/claude-use/commit/8577f79738cbbeced0ec06f2f65df3739222df32))
* parse a leading [@name](https://github.com/name) identity token from launcher argv ([cffb339](https://github.com/ExaDev/claude-use/commit/cffb339b57a271398e3d1608c95482ac63e919ed))
* plan the symlink farm and reconcile data written into it ([fe65734](https://github.com/ExaDev/claude-use/commit/fe6573496341acdd48aca9d414f5a5df0a9cc42b))
* rank entries rules by a total specificity order, layer first ([662ca70](https://github.com/ExaDev/claude-use/commit/662ca702817447567b3ab281ad08dd536d89aa27))
* refuse to launch when an ambient credential would bypass identity isolation ([9151762](https://github.com/ExaDev/claude-use/commit/9151762c884a30cde2e368e60dce1b382b9997cf))
* resolve a cascade to per-entry sharing decisions in two phases ([fd5b085](https://github.com/ExaDev/claude-use/commit/fd5b08586aa315fac2fb406bc34d6c39c876c400))
* resolve launch flags and assemble the spawned binary's argv and env ([6194296](https://github.com/ExaDev/claude-use/commit/6194296237b3e8acd2f4aeb587923b5795d69a47))
* resync the active identity's farm on every claude launch ([335af65](https://github.com/ExaDev/claude-use/commit/335af650e353a4c28a79dd1b53b7577d6e06cabf))
* serialise concurrent farm resyncs of one identity behind a lock file ([d6b7862](https://github.com/ExaDev/claude-use/commit/d6b786241546ce8892e9b66d8f9d5980c79bf835))
* spawn the real claude binary and propagate its exit code ([7144517](https://github.com/ExaDev/claude-use/commit/71445176e51a4656dece81a77f6381a14a5c2301))
* split CLAUDE_EXTRA_FLAGS into multiple forwarded argv entries ([a0f4e29](https://github.com/ExaDev/claude-use/commit/a0f4e293b21c0affd90f380d65471d626adce16d))
* thread one-off --category/--share/--hide overrides into the farm resync ([4690615](https://github.com/ExaDev/claude-use/commit/4690615c9541a69fcee2997b347215cd8ca9fe87))

### Bug Fixes

* make install.sh actually download the release binary it installs ([c176320](https://github.com/ExaDev/claude-use/commit/c176320fd2fbf2e0a70e5aaf47c0ad15015526b1))
