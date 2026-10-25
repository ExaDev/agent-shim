## [11.65.9](https://github.com/ExaDev/agent-shim/compare/v11.65.8...v11.65.9) (2026-10-25)

### Bug Fixes

* **test:** wait for the respawn marker's text, not its existence ([f81673b](https://github.com/ExaDev/agent-shim/commit/f81673b90c98e1e5404adee796ecbcf6eea3d7f5)), closes [#580](https://github.com/ExaDev/agent-shim/issues/580)

## [11.65.8](https://github.com/ExaDev/agent-shim/compare/v11.65.7...v11.65.8) (2026-10-25)

### Documentation

* record the managed settings, policy limits and pools answers of a Team login ([99791d7](https://github.com/ExaDev/agent-shim/commit/99791d789780e3f518c2fe780f63cf29c8145eda))

## [11.65.7](https://github.com/ExaDev/agent-shim/compare/v11.65.6...v11.65.7) (2026-10-25)

### Documentation

* add the routine write answers and the ultrareview session as observed ([b9f1edd](https://github.com/ExaDev/agent-shim/commit/b9f1eddb3aa4dfff7be4f84f98242f17eb315761))

## [11.65.6](https://github.com/ExaDev/agent-shim/compare/v11.65.5...v11.65.6) (2026-10-25)

### Bug Fixes

* **test:** hold the zombie case's ps run to a limit it cannot reach ([49d9760](https://github.com/ExaDev/agent-shim/commit/49d9760058faa8c0388297a13f9ffd5093769ab6)), closes [#574](https://github.com/ExaDev/agent-shim/issues/574)

## [11.65.5](https://github.com/ExaDev/agent-shim/compare/v11.65.4...v11.65.5) (2026-10-25)

### Documentation

* add the client-only contracts and observed session states ([bcdc7a0](https://github.com/ExaDev/agent-shim/commit/bcdc7a00786a66d764459213594cd8869af2811f))
* add the routine, session list and state values the second capture showed ([117a512](https://github.com/ExaDev/agent-shim/commit/117a5123c841689d7ef3d11896e46716103ce5da))
* record the service contracts behind Claude Code's login-gated features ([1f46460](https://github.com/ExaDev/agent-shim/commit/1f464601fd181d2fc0f64898cbe074ba29d35a85))

## [11.65.4](https://github.com/ExaDev/agent-shim/compare/v11.65.3...v11.65.4) (2026-10-24)

### Bug Fixes

* **frontdoor:** keep a client abort during the routing scan from crashing the door ([3185775](https://github.com/ExaDev/agent-shim/commit/3185775c982e3a5af5d182e8bceaa120f0f009b0))

## [11.65.3](https://github.com/ExaDev/agent-shim/compare/v11.65.2...v11.65.3) (2026-10-24)

### Bug Fixes

* **deps:** move zod, undici and ip-address to their patched releases ([667975c](https://github.com/ExaDev/agent-shim/commit/667975c4725e5fe701896b43e71d75d822914d66))
* **deps:** override fast-uri and body-parser to their patched releases ([cda2f53](https://github.com/ExaDev/agent-shim/commit/cda2f530e94fa4d57bcca886cc176328462555b3))

## [11.65.2](https://github.com/ExaDev/agent-shim/compare/v11.65.1...v11.65.2) (2026-10-22)

### Build System

* **deps:** align the remaining orpc packages with the server bump ([2c59f44](https://github.com/ExaDev/agent-shim/commit/2c59f445df04f0d3e2aca8eb96f6c6f3f065aaa3))

## [11.65.1](https://github.com/ExaDev/agent-shim/compare/v11.65.0...v11.65.1) (2026-10-22)

### Performance Improvements

* **frontdoor:** admit requests from an in-memory view of the session registry ([a9f77f5](https://github.com/ExaDev/agent-shim/commit/a9f77f565777418b7008ceabe61b2fae35d9a771))
* **frontdoor:** answer a launch's models block from the registry view ([1cf5478](https://github.com/ExaDev/agent-shim/commit/1cf5478cf949904d449f7236de98a81d49db3cb1))

### Tests

* **usage:** isolate the in-door launch test from an inherited trust bundle ([0c07d18](https://github.com/ExaDev/agent-shim/commit/0c07d1802dd6b7ea3e79107256fcf753f7397755))

## [11.65.0](https://github.com/ExaDev/agent-shim/compare/v11.64.1...v11.65.0) (2026-10-22)

### Features

* **statusline:** draw a line of your own text and the output of a program ([83a6622](https://github.com/ExaDev/agent-shim/commit/83a66227f16956436bf04b1f39344de2a6ac8022))
* **statusline:** list the extra segment in claude-hud's presets ([638c36b](https://github.com/ExaDev/agent-shim/commit/638c36bcab6944e3d5ef4cc3ef3f1fcf6d3539c6))

### Bug Fixes

* **config:** refuse a dash-led program for the extra command ([2b9fda0](https://github.com/ExaDev/agent-shim/commit/2b9fda00bb9aa3f2077cb013a6e2d4d29e845f46))
* **config:** refuse the statusline's extra command in a project file ([9c957b4](https://github.com/ExaDev/agent-shim/commit/9c957b48b9533eb0dd786a7cf3ccdf0f4bfb1b07))
* **frontdoor:** refuse the extra command in a delegated config write ([7dd9c1f](https://github.com/ExaDev/agent-shim/commit/7dd9c1fd25796698cf72d80d0283b7a35ebb3016))
* **statusline:** ask a word for one more character than is left of the limit ([c2c1c12](https://github.com/ExaDev/agent-shim/commit/c2c1c12c4c3b6a376079579d1772fa2f63530cfc))
* **statusline:** call the display-text cleaner with the name alone ([50a6132](https://github.com/ExaDev/agent-shim/commit/50a61322e2fcbc6e56e94730164bc236e97b2cc9))
* **statusline:** draw the first line of output that only happens to parse as JSON ([392b8eb](https://github.com/ExaDev/agent-shim/commit/392b8ebab7f17eea2f54ffa2aeb1388738c4f0f6))
* **statusline:** keep apart the words an extra command's output separates with a tab ([912c083](https://github.com/ExaDev/agent-shim/commit/912c083c56adc69f2bc5ca43a0a00ddb8aa75498))
* **statusline:** kill a program that outruns its limit with a signal it cannot trap ([edca4d9](https://github.com/ExaDev/agent-shim/commit/edca4d920e24b38ba7c473a3e035974b786724e1))
* **statusline:** refuse output that reaches the size limit under every shell ([917ad7e](https://github.com/ExaDev/agent-shim/commit/917ad7ece26e5e03a506cbef96521d5740564af1))
* **statusline:** run the size-limited command in a form dash accepts, for the extra command only ([97467a1](https://github.com/ExaDev/agent-shim/commit/97467a118f6532b133eeb9db7fcf6677d7ee9c63))
* **statusline:** sweep each stale run directory on its own ([aa355b4](https://github.com/ExaDev/agent-shim/commit/aa355b434a94180789ac98f89be622fc1a783390))
* **statusline:** write a program's output to a file so a leftover process cannot hold the call ([f81693f](https://github.com/ExaDev/agent-shim/commit/f81693f652b82230605c7872f0c04491baacb02e))

### Code Refactoring

* drop execFileSyncBlocking, which nothing calls now ([b1f52b0](https://github.com/ExaDev/agent-shim/commit/b1f52b0eb44c2d5f360e851de40f75cd4f20efae))

### Documentation

* **frontdoor:** name the extra group wherever the API's refusals are listed ([dfc39c4](https://github.com/ExaDev/agent-shim/commit/dfc39c499a9684658018dd33d261e51f1bfeec3f))
* **statusline:** name the runs that merge into one grapheme as read whole ([9ddf159](https://github.com/ExaDev/agent-shim/commit/9ddf159f198658674ea6049f4548778c3c1ce0b5))
* **statusline:** say exactly which layers can set the extra command ([ca91ae0](https://github.com/ExaDev/agent-shim/commit/ca91ae0c7e90b3ab6f8be05fa40ef62ac2adba01))
* **statusline:** say how colourised JSON and an unterminated operating system command are read ([9a749e6](https://github.com/ExaDev/agent-shim/commit/9a749e69e4500d02e59868d9c5fccb23364cdac1))
* **statusline:** say the custom line is a line of its own in the compact layout ([2c5ee2d](https://github.com/ExaDev/agent-shim/commit/2c5ee2dba29e1d38f3c5c2627fb97ca404a8aed8))
* **statusline:** say what the extra command inherits and where it may be set from ([ddd9e41](https://github.com/ExaDev/agent-shim/commit/ddd9e4122eaf4fbcf2d7a11864bc9c47aa7b5da1))
* **statusline:** say where a relative extra command resolves and how control characters are drawn ([a7e7877](https://github.com/ExaDev/agent-shim/commit/a7e787755611c238e3399e6c519627524ebcda1d))
* **statusline:** state what the custom line refuses and how an extra command's output is read ([6a7edf0](https://github.com/ExaDev/agent-shim/commit/6a7edf07fb78da876c59b978d7f48c9ff6322b13))

### Tests

* **config:** prove the extra command is refused in every project file through the real loader ([7f55191](https://github.com/ExaDev/agent-shim/commit/7f55191d23348f4b86c2a43eae839233b609d294))
* **config:** show a project file cannot reach a profile outside the profiles directory by path ([dd7acb8](https://github.com/ExaDev/agent-shim/commit/dd7acb8797c88814c7a4b971b0b9d23f203bd0bc))
* **statusline:** keep git and Jujutsu on a pipe ([e417be5](https://github.com/ExaDev/agent-shim/commit/e417be58ae820d9e3c5adccff6edb32006ceaa6d))
* **statusline:** pin the custom line to a line of its own in the compact layout ([2711ed6](https://github.com/ExaDev/agent-shim/commit/2711ed6bc3d84c9e5bc85cc788ac732a107d32b4))
* **statusline:** pin the owner-only mode of a program's output file ([43b5c71](https://github.com/ExaDev/agent-shim/commit/43b5c71cba28434d4b71c359917c6f22ba870ba3))

### Styles

* **config:** write the full preset's rows key bare, as its siblings are ([5b04776](https://github.com/ExaDev/agent-shim/commit/5b04776dbc57297a83bb6ceaef8a2ca828b697c7))

## [11.64.1](https://github.com/ExaDev/agent-shim/compare/v11.64.0...v11.64.1) (2026-10-22)

### Bug Fixes

* **deps:** move vitest and its coverage provider to the release that patches the mocker advisory ([7e1c0e4](https://github.com/ExaDev/agent-shim/commit/7e1c0e453713c4a43e036dc117c812dc7b9d27b4))

## [11.64.0](https://github.com/ExaDev/agent-shim/compare/v11.63.0...v11.64.0) (2026-10-21)

### Features

* **statusline:** draw what the session is doing as tools, skills, mcp, agents and todos rows ([6dbcd55](https://github.com/ExaDev/agent-shim/commit/6dbcd553bfcd2fa7f4ff2921a41fc28139812d60))
* **statusline:** fold a session's tool calls, agents, todos, skills and servers from its transcript ([6fc9a73](https://github.com/ExaDev/agent-shim/commit/6fc9a730a7c808a307a2c4de8124b77064129b13))
* **statusline:** turn the activity rows on in the presets that claude-hud's turn them on in ([82fa94f](https://github.com/ExaDev/agent-shim/commit/82fa94fc6874f91ec16da8e1a5753aa45bcf64a6))
* **statusline:** write the activity rows' words from the message catalogue ([3b800dd](https://github.com/ExaDev/agent-shim/commit/3b800ddd589970caf2f3c42485e448bb83012ec4))

### Bug Fixes

* **statusline:** do not count history a resumed session writes again, and keep a queued announcement ([b979bcc](https://github.com/ExaDev/agent-shim/commit/b979bcc4f0d9b507295111082e7adb4a8a7c0b37))
* **statusline:** finish a tool call from a result written to the file before it ([74441f6](https://github.com/ExaDev/agent-shim/commit/74441f687a095cfbd3cfd168ddb4a02181673149))
* **statusline:** finish late results, restart a reused task list and keep teammates running ([948000e](https://github.com/ExaDev/agent-shim/commit/948000e0ded1cc04c7671021f6486e5d39aa1637))
* **statusline:** fit the activity rows to the width, count every name, keep English out of the facts ([3a9905f](https://github.com/ExaDev/agent-shim/commit/3a9905f3f4d6ed730c93e3236171b039b50378ba))
* **statusline:** fit the agents and todos rows to the width ([1d1b8dd](https://github.com/ExaDev/agent-shim/commit/1d1b8ddead71344e7c3338bdf3f2fc01a86d7eba))
* **statusline:** keep a mis-stamped call from blinding the activity rows, and seed the end fold ([6538455](https://github.com/ExaDev/agent-shim/commit/65384554eef69c300a523264848ac9b94ba5610e))
* **statusline:** leave out a todo list the end of a long transcript has edited in place ([08c2191](https://github.com/ExaDev/agent-shim/commit/08c21914ed2dc764d2a72e5a290def59f365b174))
* **statusline:** name a task by the identifier its TaskCreate result gives ([d1a790c](https://github.com/ExaDev/agent-shim/commit/d1a790c808d50a84023bdd1aedaf4085931d8269))
* **statusline:** read tool calls only from the records that make and answer them ([d005498](https://github.com/ExaDev/agent-shim/commit/d005498427dbf7dc54b7b305d6dc467829ee0397))
* **statusline:** stop one late call from freezing the replay floor, and keep skipped calls ([0192aa1](https://github.com/ExaDev/agent-shim/commit/0192aa1f273492bdfd2934fa23c4f318038d8e79))
* **statusline:** tell a replayed call from a new one by its time, and keep catch-up lists whole ([24b810c](https://github.com/ExaDev/agent-shim/commit/24b810c20e7016ad116a6b11256bc3cc346b1780))
* **statusline:** tell a running call from an abandoned one by what the transcript shows ([3c21caf](https://github.com/ExaDev/agent-shim/commit/3c21caff48a31ab99181168674fe2bf215057046))

### Code Refactoring

* **statusline:** share the Claude model ID reader, ellipsis cutting and span formatting ([5776979](https://github.com/ExaDev/agent-shim/commit/5776979685236331cb9407f489b9cbc289a6dd96))

### Tests

* **statusline:** pin a finished agent's start of zero, and correct the time fallback's note ([59cc116](https://github.com/ExaDev/agent-shim/commit/59cc11658690dfa65f93515ca238c7717436f2d8))
* **statusline:** pin the boundaries of the transcript reader, the rows' fit and the span formats ([d7c7c0f](https://github.com/ExaDev/agent-shim/commit/d7c7c0fda13c50bc62eaea474a223c8afe9f54f2))
* **statusline:** pin the cap on the text the activity state keeps ([71311c6](https://github.com/ExaDev/agent-shim/commit/71311c6d82aeae154d669c4ac55b053eb88933c1))
* **statusline:** pin the session fold's unrecognised shapes, and mark its equivalents ([9befd09](https://github.com/ExaDev/agent-shim/commit/9befd097084052cadd385616689465b49605c912))

## [11.63.0](https://github.com/ExaDev/agent-shim/compare/v11.62.3...v11.63.0) (2026-10-21)

### Features

* **frontdoor:** answer connections a draining listener accepted before it stopped ([03123fe](https://github.com/ExaDev/agent-shim/commit/03123fe34ddf9fdb0406ad49443a1a32738981b2))
* **frontdoor:** hand the listening sockets to the successor on a planned replacement ([ffb437d](https://github.com/ExaDev/agent-shim/commit/ffb437dd75fb9dc8090daf69cc54ca0659789de6)), references [#561](https://github.com/ExaDev/agent-shim/issues/561)

## [11.62.3](https://github.com/ExaDev/agent-shim/compare/v11.62.2...v11.62.3) (2026-10-21)

### Bug Fixes

* **frontdoor:** keep a door the machine did not schedule instead of replacing it ([1005316](https://github.com/ExaDev/agent-shim/commit/100531683ed0bf8aa40e4dcb7c7fdea98573f9ef)), references [#557](https://github.com/ExaDev/agent-shim/issues/557)
* **frontdoor:** log a stall sample only when the sampler wrote one ([b20fc0f](https://github.com/ExaDev/agent-shim/commit/b20fc0f40129474ef2ccf8046ef2cdb74a7a8255)), references [#557](https://github.com/ExaDev/agent-shim/issues/557)

## [11.62.2](https://github.com/ExaDev/agent-shim/compare/v11.62.1...v11.62.2) (2026-10-20)

### Bug Fixes

* **frontdoor:** prune only the launches the liveness check covered ([281d048](https://github.com/ExaDev/agent-shim/commit/281d04877c2340e8cfb81af7869912c5ab51243f))

## [11.62.1](https://github.com/ExaDev/agent-shim/compare/v11.62.0...v11.62.1) (2026-10-20)

### Bug Fixes

* **deps:** take the patched vite beneath vitest ([047a3fe](https://github.com/ExaDev/agent-shim/commit/047a3fe13a79b5407a523391cb6913beb9d85db1))

## [11.62.0](https://github.com/ExaDev/agent-shim/compare/v11.61.0...v11.62.0) (2026-10-20)

### Features

* **statusline:** choose a named bundle of settings with a preset ([c1ee34d](https://github.com/ExaDev/agent-shim/commit/c1ee34d9ad18b61ca45223cc66e2d57d9fa6d115))
* **statusline:** write the statusline's words from a catalogue and choose their language ([12fc511](https://github.com/ExaDev/agent-shim/commit/12fc511ee5464189cb630ed54c48dbbbb39c2b25))

### Bug Fixes

* **statusline:** define the presets as claude-hud does, and read its Chinese tags ([745df94](https://github.com/ExaDev/agent-shim/commit/745df942ec8fd41dd35afcfa09c43e3b41a7fa1e))
* **statusline:** let each language own the punctuation between labels and values ([fb1672d](https://github.com/ExaDev/agent-shim/commit/fb1672df062311f1d1ac9c7e044c7e0ae13dca97))
* **statusline:** paint the added directories as separate runs, and make writing around a value total ([5901662](https://github.com/ExaDev/agent-shim/commit/5901662a092f15accd0cd30dc6ee0e605038b847))
* **statusline:** say a detached head and a reset time in the catalogue's words ([08df32b](https://github.com/ExaDev/agent-shim/commit/08df32b038e1885f7a37f937d5c7fd60e41de423))

### Documentation

* **statusline:** say that the presets set the token breakdown ([fa22b7d](https://github.com/ExaDev/agent-shim/commit/fa22b7d1883915c41aebb16eb49cf3d41915a883))

### Tests

* **statusline:** classify the rows layout as plumbing, and check presets beside the layout settings ([2d7c543](https://github.com/ExaDev/agent-shim/commit/2d7c543321e4ca6fb520616755664f1350844f2a))
* **statusline:** hold every module that writes for the screen to the catalogue ([6b5ddee](https://github.com/ExaDev/agent-shim/commit/6b5ddeec73de1c4f02cc15612205b5cee09b32d9))
* **statusline:** pin the wording of every message in each language ([34a1b09](https://github.com/ExaDev/agent-shim/commit/34a1b09e26d4a91fdbbd11f924b596048d832dd0))
* **statusline:** refuse a window label that is too long, a language and a preset that do not exist ([4ff4961](https://github.com/ExaDev/agent-shim/commit/4ff49618d7e2dba35bac3b0e0738b32238e03b55))

## [11.61.0](https://github.com/ExaDev/agent-shim/compare/v11.60.2...v11.61.0) (2026-10-20)

### Features

* **statusline:** choose which rows share a line and which are pushed to the right ([348b86f](https://github.com/ExaDev/agent-shim/commit/348b86fbb5caeb0d63b3d3c964921e2ad14accf2))
* **statusline:** draw everything on one line, and a rule below the header ([78f19ad](https://github.com/ExaDev/agent-shim/commit/78f19ad7353e933c58a88ad6f0e3b69ef6129109))
* **statusline:** set the width to draw for when the terminal's is unknown or untrusted ([f90f852](https://github.com/ExaDev/agent-shim/commit/f90f8526a3372410e3ff61b6f050bf0effca7bbd))

### Bug Fixes

* **statusline:** draw to a configured width exactly, and refuse one too narrow to draw in ([27ffbd7](https://github.com/ExaDev/agent-shim/commit/27ffbd7aa82d8bfceb21b4eeaaa22ec04f7c77d3))
* **statusline:** end a run of bars at a row of text that draws nothing ([52c89bb](https://github.com/ExaDev/agent-shim/commit/52c89bb6c08c5155b3795062a12d3fa6282cb90b))
* **statusline:** keep a merge unit's groups to their own alignment on a narrow line ([0fef60c](https://github.com/ExaDev/agent-shim/commit/0fef60ce675e2b1683b7f14d4ac2dc5a8f718829))
* **statusline:** keep the groups of one unit to their own alignment, as the grid always did ([832fdbd](https://github.com/ExaDev/agent-shim/commit/832fdbd95232eb4ef340f9bb175fe88de8249ee7))
* **statusline:** share a line between bar rows only, unless a group says otherwise ([c1ef583](https://github.com/ExaDev/agent-shim/commit/c1ef5839ead5abdf4c6057981862d5ad983c942b))
* **statusline:** treat a merge group with nothing to show like the rows in it ([8a6fc91](https://github.com/ExaDev/agent-shim/commit/8a6fc914e0372b7fabd08d68235deda85fb12f29))

### Documentation

* **statusline:** build the width descriptions from the constants, and say where maxWidth differs ([97dc6e2](https://github.com/ExaDev/agent-shim/commit/97dc6e2a8c734f3dbf500ee605f57af5d977fda0))
* **statusline:** describe how the layout is split from the elements ([2f720f3](https://github.com/ExaDev/agent-shim/commit/2f720f3c88020d3ee474ba55b16420ef52684b7b))
* **statusline:** say how a list of groups is written in the option help and the model ([81dbeb4](https://github.com/ExaDev/agent-shim/commit/81dbeb4f182cd7de9e0fe477b893586361a986d9))
* **statusline:** say what a merge group with nothing to show does ([dde8cb2](https://github.com/ExaDev/agent-shim/commit/dde8cb29d2a6fb699a45885924153ec024db7906))

### Tests

* **statusline:** pin the one bar to a row that units of their own may fall back to ([6dfe59f](https://github.com/ExaDev/agent-shim/commit/6dfe59f50dd7fadb7f6d28fd440a80502fcd73ff))

## [11.60.2](https://github.com/ExaDev/agent-shim/compare/v11.60.1...v11.60.2) (2026-10-20)

### Bug Fixes

* **config:** derive the longest name from the files made beside it, and guard the door's stat ([ac0ff6a](https://github.com/ExaDev/agent-shim/commit/ac0ff6aa760c4116cc0ff0d8a319f46acb0f636d))
* **config:** hold names to two rules so stored files keep working and no name reaches a path ([006374d](https://github.com/ExaDev/agent-shim/commit/006374d6dbfe3af20533cff282e2093cf469a8d7))
* **config:** keep a name from a configuration file inside the directory it names a file in ([052b3e2](https://github.com/ExaDev/agent-shim/commit/052b3e2e1290a475ada15aeb87349cd834202245))

## [11.60.1](https://github.com/ExaDev/agent-shim/compare/v11.60.0...v11.60.1) (2026-10-20)

### Bug Fixes

* **usage:** plan the door's identity launches over probes run without blocking ([9e2da87](https://github.com/ExaDev/agent-shim/commit/9e2da87d25371875825ec201761534464b40aae8))

## [11.60.0](https://github.com/ExaDev/agent-shim/compare/v11.59.0...v11.60.0) (2026-10-20)

### Features

* **frontdoor:** capture a native stack when a stalled door's main thread cannot be paused ([8b75db1](https://github.com/ExaDev/agent-shim/commit/8b75db127ee53407c953b8c46b59f94dff83e4cd))

### Bug Fixes

* **frontdoor:** keep replacing a stalled door with a growing cooldown instead of stopping ([0f580ee](https://github.com/ExaDev/agent-shim/commit/0f580eebd7eb78db9ad0e803f1d9fb67f781f364))

### Documentation

* **architecture:** the front door never blocks its event loop, and how that is enforced ([1f08d20](https://github.com/ExaDev/agent-shim/commit/1f08d2090a60cc4feec2baa6461966e6667afb05))

## [11.59.0](https://github.com/ExaDev/agent-shim/compare/v11.58.0...v11.59.0) (2026-10-20)

### Features

* **statusline:** draw a session's token totals as a row ([116f404](https://github.com/ExaDev/agent-shim/commit/116f4043b889b384d88fb3af55d358bd90c9ee95))
* **statusline:** give the context row claude-hud's options ([cc71a14](https://github.com/ExaDev/agent-shim/commit/cc71a142a51cb4056500f98becd07a5322439ac7))
* **statusline:** let a layer unset an optional setting a shallower layer set ([ef42605](https://github.com/ExaDev/agent-shim/commit/ef426050f57e9adbbcbf99e4e3806d827e8904f6))

### Bug Fixes

* **statusline:** catch up with a long transcript a read at a time ([a6bd9fd](https://github.com/ExaDev/agent-shim/commit/a6bd9fde8ba9f34beddcf1d11ec6e942b6bfbe5a))
* **statusline:** keep the cache tier an early write showed while catching up ([55433d4](https://github.com/ExaDev/agent-shim/commit/55433d4e3672b8b47334d982b7eddeae9cbb99b6))
* **statusline:** keep the end of a long transcript's facts right while catching up ([3743711](https://github.com/ExaDev/agent-shim/commit/3743711cc7c3d406c52a40f1f15caba5cf338948))
* **statusline:** make the context row's edge cases and unset settings exact ([16a43fd](https://github.com/ExaDev/agent-shim/commit/16a43fdab4f49c44b8a634923405b86e3aa21cda))

### Documentation

* **statusline:** describe how the compaction count and keys without defaults behave ([a880459](https://github.com/ExaDev/agent-shim/commit/a880459a23ebc3f841f6716e5948450f05861bbd))
* **statusline:** state when the end of a long transcript sets a fact at once ([a2f6c34](https://github.com/ExaDev/agent-shim/commit/a2f6c3433481a6a98013005c0825fa3eb2ca80dc))

### Tests

* **statusline:** cover the end of a long transcript at its edges ([3af5f56](https://github.com/ExaDev/agent-shim/commit/3af5f5608feddcab4a9e7202123018d2d257fb61))
* **statusline:** pin the context row at exactly its thresholds ([68b2c61](https://github.com/ExaDev/agent-shim/commit/68b2c61057186ccf50e1fcf0e40b1b1ed60caf0a))

## [11.58.0](https://github.com/ExaDev/agent-shim/compare/v11.57.1...v11.58.0) (2026-10-20)

### Features

* **statusline:** draw the session from its transcript, as claude-hud does ([67a4f14](https://github.com/ExaDev/agent-shim/commit/67a4f1481197a2a3d2b0c389ae087492eef73cf1))
* **statusline:** read the session transcript incrementally for the elements ([04a3d4c](https://github.com/ExaDev/agent-shim/commit/04a3d4c39cf2aa59c12a4f39a710a4a526737a20))

### Bug Fixes

* **statusline:** forget old session caches whichever kind of file is written first ([a3581aa](https://github.com/ExaDev/agent-shim/commit/a3581aa7f576de2036356945e86a264564b974f3))
* **statusline:** write the session start under the clock settings ([df550b8](https://github.com/ExaDev/agent-shim/commit/df550b87a47fd799d6caeeea5e6d62df3adbae48))

## [11.57.1](https://github.com/ExaDev/agent-shim/compare/v11.57.0...v11.57.1) (2026-10-20)

### Bug Fixes

* **frontdoor:** resolve a launch without blocking the event loop ([497ab36](https://github.com/ExaDev/agent-shim/commit/497ab3631fad879059a4c2f0e995783b0847ae6b))

### Code Refactoring

* **spawn:** route every synchronous spawn through a wrapper that refuses inside the door ([935d80f](https://github.com/ExaDev/agent-shim/commit/935d80f723a399ec4ea16b26e113afee1bf7b649))

## [11.57.0](https://github.com/ExaDev/agent-shim/compare/v11.56.1...v11.57.0) (2026-10-20)

### Features

* **statusline:** draw the session's cost, today's spend, memory and configuration counts ([2c5a443](https://github.com/ExaDev/agent-shim/commit/2c5a44327adb460671336122b015bc3e9ed4b301))
* **statusline:** give the renderer ports to files, state and memory ([e8006b5](https://github.com/ExaDev/agent-shim/commit/e8006b5391e6e55f78fa506309f51b596fcc684c))
* **usage:** record the client's conversation id on each request ([8fa5fde](https://github.com/ExaDev/agent-shim/commit/8fa5fde19b0a979ec45305eeaa001fddd825be67))

### Bug Fixes

* **statusline:** remove the duplicate boolean key kind and test the width and link handling ([a9755ac](https://github.com/ExaDev/agent-shim/commit/a9755acd844e9b7380568a461c766335374186cf))

## [11.56.1](https://github.com/ExaDev/agent-shim/compare/v11.56.0...v11.56.1) (2026-10-20)

### Bug Fixes

* **frontdoor:** answer the door's own liveness without reading the process table ([2cef79a](https://github.com/ExaDev/agent-shim/commit/2cef79a340de1c8fc1ae194e4ee5c40a4f865ce8))

## [11.56.0](https://github.com/ExaDev/agent-shim/compare/v11.55.0...v11.56.0) (2026-10-20)

### Features

* **credential:** resolve a credential without blocking the calling thread ([36fa5c7](https://github.com/ExaDev/agent-shim/commit/36fa5c79f41aaaaf20a2986090b1272272be1422))

### Bug Fixes

* **frontdoor:** resolve provider credentials without blocking the event loop ([2be1a14](https://github.com/ExaDev/agent-shim/commit/2be1a14ba173ad780816a052ca782e1332d2a89f))

## [11.55.0](https://github.com/ExaDev/agent-shim/compare/v11.54.1...v11.55.0) (2026-10-20)

### Features

* **statusline:** configure how the quota row shows usage and resets ([c7c88ee](https://github.com/ExaDev/agent-shim/commit/c7c88eee0c27325c9fa701bf3bbecf94beb3adfc))

### Bug Fixes

* **statusline:** decide that text draws nothing by its width, in one shared definition ([5959dc8](https://github.com/ExaDev/agent-shim/commit/5959dc827ab3da201941a9424cc20433887c7397))
* **statusline:** drop model names a person cannot see and test the quota row's wrapping by columns ([6a7e28c](https://github.com/ExaDev/agent-shim/commit/6a7e28ca428e76ec4bf924f08be4fe46c9f396a4))
* **statusline:** keep escape sequences whole when cutting text to a width ([98f894f](https://github.com/ExaDev/agent-shim/commit/98f894f40cbfef0aa606f550d889f7292af7cfe1))
* **statusline:** keep legitimate names whole and measure labels and bar glyphs in columns ([69ae32b](https://github.com/ExaDev/agent-shim/commit/69ae32b25ebcca1d9270f9fab73e0dd121363e0c))
* **statusline:** keep word breaks and Hangul clusters when cleaning a name ([41876d4](https://github.com/ExaDev/agent-shim/commit/41876d4dfbe3bc4fc055412acf1438a2672f0673))
* **statusline:** measure a line in terminal columns, not UTF-16 units ([37ba6ab](https://github.com/ExaDev/agent-shim/commit/37ba6ab7e4e731f085a60a7dd5837730564730a8))
* **statusline:** show seconds for a reset less than a minute away ([1fafce5](https://github.com/ExaDev/agent-shim/commit/1fafce5a6236d4bcedd3f9d9214215f4bfffaa04))
* **statusline:** wrap the quota row's text forms and tell wall-clock times as the locale does ([eb91151](https://github.com/ExaDev/agent-shim/commit/eb91151ce711009909f74239512ebafdf38d3dae))
* **statusline:** write wall-clock times in the locale's own short time form ([b50d5ea](https://github.com/ExaDev/agent-shim/commit/b50d5eab0993d5d63e5f999f24feb66d46e4aaca))

### Code Refactoring

* **frontdoor:** take the subscription window lengths from the pool ranking ([e39078e](https://github.com/ExaDev/agent-shim/commit/e39078e5300c19de56111a566279e06081d83aa0))
* **statusline:** drop unused state from the width cut and write glyphs as escapes ([e2ab29b](https://github.com/ExaDev/agent-shim/commit/e2ab29b1a88cfcb9a87f3312761556721a27232f))

### Documentation

* **statusline:** state the duration form by what it writes ([5e24ea1](https://github.com/ExaDev/agent-shim/commit/5e24ea143120bb715556ed272b4e639a459c95c1))

### Tests

* **statusline:** pin the Hangul jamo ranges that keep a filler in its cluster ([5576549](https://github.com/ExaDev/agent-shim/commit/557654912e3f8591106c75bad3d40b7ca7de41e6))

## [11.54.1](https://github.com/ExaDev/agent-shim/compare/v11.54.0...v11.54.1) (2026-10-20)

### Bug Fixes

* **frontdoor:** read session liveness without blocking the door's event loop ([dc1ba10](https://github.com/ExaDev/agent-shim/commit/dc1ba108c5b3d183ab8ff94fd4bd062e6b38ba50))

## [11.54.0](https://github.com/ExaDev/agent-shim/compare/v11.53.0...v11.54.0) (2026-10-20)

### Features

* **statusline:** model and identity segments ([09746c7](https://github.com/ExaDev/agent-shim/commit/09746c73938e7395f96ac67c611c50554a10333c))
* **statusline:** read the end of a file through the ports ([492015e](https://github.com/ExaDev/agent-shim/commit/492015e3bd0192347d1ef754c6f29619596ab516))

### Bug Fixes

* **statusline:** find the newest assistant record by reading the transcript backwards ([6003185](https://github.com/ExaDev/agent-shim/commit/60031857701e34ef18afd93cbb19e2ec68938d74))
* **statusline:** read dated model ids and an empty configuration directory correctly ([08ee49d](https://github.com/ExaDev/agent-shim/commit/08ee49d1dc6bba4e3f7c9c1c025aecd1d1820288))

### Tests

* **statusline:** cut a chunk edge inside a multi-byte character of the model and advisor ([3defed4](https://github.com/ExaDev/agent-shim/commit/3defed4f0c12c6573d3e7dfa2492a650c80e1441))

## [11.53.0](https://github.com/ExaDev/agent-shim/compare/v11.52.1...v11.53.0) (2026-10-19)

### Features

* **statusline:** draw the project path, version control status and changed files ([8e7f5ee](https://github.com/ExaDev/agent-shim/commit/8e7f5ee4f3a7aee1e631eb2c6b4eae6b1a9cfc9b))
* **statusline:** let elements inspect the file system and clean untrusted text ([ae04835](https://github.com/ExaDev/agent-shim/commit/ae04835b5072d9bcb1cda4546b8eaec08fc905b5))

## [11.52.1](https://github.com/ExaDev/agent-shim/compare/v11.52.0...v11.52.1) (2026-10-19)

### Code Refactoring

* **statusline:** give elements the client's payload and ports to the machine ([6380b51](https://github.com/ExaDev/agent-shim/commit/6380b51e10b2e14a136202bfbb2a8faefb2bbcf2))

## [11.52.0](https://github.com/ExaDev/agent-shim/compare/v11.51.0...v11.52.0) (2026-10-19)

### Features

* **statusline:** colour the statusline by role and choose the bar characters ([fe5746c](https://github.com/ExaDev/agent-shim/commit/fe5746c768670756612635fcd75ef8d755063f71)), references [#rrggbb](https://github.com/ExaDev/agent-shim/issues/rrggbb)

## [11.51.0](https://github.com/ExaDev/agent-shim/compare/v11.50.2...v11.51.0) (2026-10-19)

### Features

* **statusline:** track parity with claude-hud setting by setting ([24ee711](https://github.com/ExaDev/agent-shim/commit/24ee7119622f5a75b7fd1b393a26e8ae34126a39))

### Code Refactoring

* **statusline:** group the settings and split the renderer into elements ([9896d1c](https://github.com/ExaDev/agent-shim/commit/9896d1cafaf2ef4dcff24ecb611dfd534dc3d229))

### Documentation

* describe the grouped statusline settings ([e2d8a9b](https://github.com/ExaDev/agent-shim/commit/e2d8a9bf2733f4360cb4b709f09d5d0a7d5ec6aa))

## [11.50.2](https://github.com/ExaDev/agent-shim/compare/v11.50.1...v11.50.2) (2026-10-19)

### Bug Fixes

* **ci:** apply the GitHub Packages scope only after the alias job's install ([a7d2134](https://github.com/ExaDev/agent-shim/commit/a7d21340ef66e4ec5cd6957e20007027acab29c8))

## [11.50.1](https://github.com/ExaDev/agent-shim/compare/v11.50.0...v11.50.1) (2026-10-19)

### Bug Fixes

* **ci:** authenticate the GitHub Packages alias job's install ([653463a](https://github.com/ExaDev/agent-shim/commit/653463a42fef6e7ec94d5f7e608ba2ff2c8fe012))

## [11.50.0](https://github.com/ExaDev/agent-shim/compare/v11.49.2...v11.50.0) (2026-10-19)

### Features

* **statusline:** configure the built-in statusline through the launch cascade ([7c2035a](https://github.com/ExaDev/agent-shim/commit/7c2035aba29ae97e9840a745e53a44a741953bd5))
* **statusline:** set the statusline's appearance on a profile ([ff2428d](https://github.com/ExaDev/agent-shim/commit/ff2428d7801a4cc6176102e81a9a6126ec5b0403))

### Documentation

* describe the statusline settings ([3fbb69a](https://github.com/ExaDev/agent-shim/commit/3fbb69ae1e5bc97a9adfa27e2e6b31e53dd72677))

## [11.49.2](https://github.com/ExaDev/agent-shim/compare/v11.49.1...v11.49.2) (2026-10-19)

### Bug Fixes

* **update:** classify an npm global under Homebrew's prefix as npm ([4d32400](https://github.com/ExaDev/agent-shim/commit/4d32400e4139c230e303195e3d56c78b70cb8364))

## [11.49.1](https://github.com/ExaDev/agent-shim/compare/v11.49.0...v11.49.1) (2026-10-19)

### Bug Fixes

* **codex:** classify quota windows by length and report utilisation as a fraction ([3b2105b](https://github.com/ExaDev/agent-shim/commit/3b2105bfe9048726413eee52c50c74accc5090e9))
* **statusline:** ignore quota windows whose reset has passed ([42dc36e](https://github.com/ExaDev/agent-shim/commit/42dc36e053ae4cbfa8860be1db4849e45c2e4e47))

## [11.49.0](https://github.com/ExaDev/agent-shim/compare/v11.48.0...v11.49.0) (2026-10-19)

### Features

* **frontdoor:** name the cause of a door's exit in its own log ([0ff81f9](https://github.com/ExaDev/agent-shim/commit/0ff81f9791552a2da91c7ee06f6a53c8a56d064d))
* **frontdoor:** retire by draining, so open tunnels survive a replacement ([abe1ae4](https://github.com/ExaDev/agent-shim/commit/abe1ae45749e86bd44fb79937e733c15e604e89e))

### Bug Fixes

* **frontdoor:** count launches of an earlier door generation as the current door's ([62462d8](https://github.com/ExaDev/agent-shim/commit/62462d86aecd12ef1a2f3af0779a40a0770f48c8))
* **frontdoor:** finish the drain's lifecycle: one door's work, one SIGTERM, one mark ([5c5aa7b](https://github.com/ExaDev/agent-shim/commit/5c5aa7b21178266d4bd588d957b572a59e14c357))

## [11.48.0](https://github.com/ExaDev/agent-shim/compare/v11.47.0...v11.48.0) (2026-10-19)

### Features

* **launcher:** keep configured hosts off the front door ([4dcfcc9](https://github.com/ExaDev/agent-shim/commit/4dcfcc957fa65efb7d5d8b858946d1943513ba27))

## [11.47.0](https://github.com/ExaDev/agent-shim/compare/v11.46.0...v11.47.0) (2026-10-19)

### Features

* **providers:** rename a provider without stranding running sessions ([5667f2a](https://github.com/ExaDev/agent-shim/commit/5667f2ae3d62d86047dd900b47898159841858f1))

## [11.46.0](https://github.com/ExaDev/agent-shim/compare/v11.45.0...v11.46.0) (2026-10-18)

### Features

* **frontdoor:** resolve every model name through the models block, and drop route-by-name ([a6769db](https://github.com/ExaDev/agent-shim/commit/a6769db08a4cb95581abff505bc0dd0a4c699a10))

## [11.45.0](https://github.com/ExaDev/agent-shim/compare/v11.44.5...v11.45.0) (2026-10-18)

### Features

* **frontdoor:** route provider-qualified model names on every session ([f70ba38](https://github.com/ExaDev/agent-shim/commit/f70ba38dd9cc5912d792991cc5f316028e4f7547))

## [11.44.5](https://github.com/ExaDev/agent-shim/compare/v11.44.4...v11.44.5) (2026-10-18)

### Bug Fixes

* **frontdoor:** start a watchdog replacement under the launcher's start lock ([23752cd](https://github.com/ExaDev/agent-shim/commit/23752cda7c0de24213621f219386b57590c2dcae))

## [11.44.4](https://github.com/ExaDev/agent-shim/compare/v11.44.3...v11.44.4) (2026-10-18)

### Bug Fixes

* **frontdoor:** retry preferred port on bind and check log existence with stat ([7f27a9b](https://github.com/ExaDev/agent-shim/commit/7f27a9b82fe94ea7fd5c4e07f12aa44d3d1aa5e2))

## [11.44.3](https://github.com/ExaDev/agent-shim/compare/v11.44.2...v11.44.3) (2026-10-18)

### Bug Fixes

* **frontdoor:** recognise a translator's model choice from the request and response bodies ([1849879](https://github.com/ExaDev/agent-shim/commit/1849879e34949c4060bd5978733368b3c9addbc9))

## [11.44.2](https://github.com/ExaDev/agent-shim/compare/v11.44.1...v11.44.2) (2026-10-18)

### Bug Fixes

* **frontdoor:** carry a route's model choice back through the headroom hop ([f530087](https://github.com/ExaDev/agent-shim/commit/f5300875076c957057ee2c00d8ffd911040ccf2f))

## [11.44.1](https://github.com/ExaDev/agent-shim/compare/v11.44.0...v11.44.1) (2026-10-18)

### Bug Fixes

* **frontdoor:** always leave a replacement door behind a watchdog kill ([403f924](https://github.com/ExaDev/agent-shim/commit/403f924b598231609c7978cf4a0a38a656f1744f))

### Continuous Integration

* drop install and cache work the CI tasks never use ([e935b65](https://github.com/ExaDev/agent-shim/commit/e935b6510a24d4177d76e256fe3c8dcfd9ec2044))

## [11.44.0](https://github.com/ExaDev/agent-shim/compare/v11.43.1...v11.44.0) (2026-10-18)

### Features

* **statusline:** name the model a routing choice served beside the session's own ([44eaa47](https://github.com/ExaDev/agent-shim/commit/44eaa47da8315e117df138271cf0eaa0c4425e8f))

## [11.43.1](https://github.com/ExaDev/agent-shim/compare/v11.43.0...v11.43.1) (2026-10-17)

### Bug Fixes

* **frontdoor:** route the names the models block defines from a provider-less session ([9338878](https://github.com/ExaDev/agent-shim/commit/9338878a2370eb8662ca0d85e3bab3314d91cc4d))

## [11.43.0](https://github.com/ExaDev/agent-shim/compare/v11.42.0...v11.43.0) (2026-10-17)

### Features

* **selection:** project a window's own pace and weigh a switch by the conversation it re-sends ([2215a23](https://github.com/ExaDev/agent-shim/commit/2215a239afca1356e227e6154423bffe4f531c11))

## [11.42.0](https://github.com/ExaDev/agent-shim/compare/v11.41.0...v11.42.0) (2026-10-17)

### Features

* **models:** route families and the cascaded models block through launches and the door ([77cde95](https://github.com/ExaDev/agent-shim/commit/77cde957f5c857ffcc5cef9ad89a3efba91cd937))

## [11.41.0](https://github.com/ExaDev/agent-shim/compare/v11.40.5...v11.41.0) (2026-10-17)

### Features

* **models:** group targets into families with identity assertions and family settings ([6a66ac5](https://github.com/ExaDev/agent-shim/commit/6a66ac589601235c6cc10a56a8ccf6966fd72dbf))

## [11.40.5](https://github.com/ExaDev/agent-shim/compare/v11.40.4...v11.40.5) (2026-10-17)

### Bug Fixes

* **frontdoor:** bump the door protocol so a route-by-name launch replaces an older door ([e829ee7](https://github.com/ExaDev/agent-shim/commit/e829ee7faa7ffed78392b463a4acb2b6aa386177))

## [11.40.4](https://github.com/ExaDev/agent-shim/compare/v11.40.3...v11.40.4) (2026-10-17)

### Bug Fixes

* **models:** say how account and family members are served instead of reading as spent ([7cda506](https://github.com/ExaDev/agent-shim/commit/7cda50696a2046c9594e22152541c8eec019bc77))

## [11.40.3](https://github.com/ExaDev/agent-shim/compare/v11.40.2...v11.40.3) (2026-10-17)

### Bug Fixes

* **frontdoor:** keep the replayed request when the Remote Control wrapper observes a resolution ([26b8c97](https://github.com/ExaDev/agent-shim/commit/26b8c977911267d963a6477871fdffb135c261a7))

## [11.40.2](https://github.com/ExaDev/agent-shim/compare/v11.40.1...v11.40.2) (2026-10-17)

### Bug Fixes

* **frontdoor:** write a routed target's wire model name without its context marker ([d05b065](https://github.com/ExaDev/agent-shim/commit/d05b0653bad80d9ac9867743195451d22754a2b4))

## [11.40.1](https://github.com/ExaDev/agent-shim/compare/v11.40.0...v11.40.1) (2026-10-17)

### Bug Fixes

* **launcher:** match only tier-default env keys when a virtual row borrows a tier ([a6304ed](https://github.com/ExaDev/agent-shim/commit/a6304eddf1142a15350261a5f7c1835c9ff1c956))

## [11.40.0](https://github.com/ExaDev/agent-shim/compare/v11.39.0...v11.40.0) (2026-10-17)

### Features

* **frontdoor:** choose a virtual model's member by its mode ([f455778](https://github.com/ExaDev/agent-shim/commit/f4557780a65764d2401697085a5c197df16ab6e5))
* **statusline:** show the target a routing session's last request was served by ([8d2cd42](https://github.com/ExaDev/agent-shim/commit/8d2cd42308675f9add5ebc7590cf9814e442b3d8))

## [11.39.0](https://github.com/ExaDev/agent-shim/compare/v11.38.0...v11.39.0) (2026-10-17)

### Features

* **supervise:** serve an acct model member by relaunching under its identity ([1dfed91](https://github.com/ExaDev/agent-shim/commit/1dfed9166d6976e27092e3f155baf0e399a1f2dc))

## [11.38.0](https://github.com/ExaDev/agent-shim/compare/v11.37.0...v11.38.0) (2026-10-17)

### Features

* **frontdoor:** route qualified model names from a provider-less session ([77d55e3](https://github.com/ExaDev/agent-shim/commit/77d55e31037255c3a46a6ba3ce63750aaaac01f1))

## [11.37.0](https://github.com/ExaDev/agent-shim/compare/v11.36.0...v11.37.0) (2026-10-17)

### Features

* **launcher:** refuse a route-by-name launch when a routed provider's credential is unusable ([7dcc406](https://github.com/ExaDev/agent-shim/commit/7dcc4068e703a179c22801d18b4cefa45df269ec))

## [11.36.0](https://github.com/ExaDev/agent-shim/compare/v11.35.0...v11.36.0) (2026-10-17)

### Features

* **launcher:** list the models catalogue for a session that routes by name ([f73005e](https://github.com/ExaDev/agent-shim/commit/f73005ea93a07039f8f8a1b123f2c44890602304))

## [11.35.0](https://github.com/ExaDev/agent-shim/compare/v11.34.0...v11.35.0) (2026-10-17)

### Features

* **launcher:** route provider-qualified model names by name from any provider session ([0add72d](https://github.com/ExaDev/agent-shim/commit/0add72df58b28d5cd1a0658deb6691e1593cfa00))

## [11.34.0](https://github.com/ExaDev/agent-shim/compare/v11.33.0...v11.34.0) (2026-10-17)

### Features

* **frontdoor:** add a router provider that resolves model names to target providers ([ab1f5b5](https://github.com/ExaDev/agent-shim/commit/ab1f5b50da59199b951636a0beef8fd57eff2a45))

## [11.33.0](https://github.com/ExaDev/agent-shim/compare/v11.32.0...v11.33.0) (2026-10-17)

### Features

* **models:** cascade the models block through profiles, directory rules and committed files ([3b6e36a](https://github.com/ExaDev/agent-shim/commit/3b6e36a8fc290f09a5c9a154b7c93b482a602f90))
* **models:** store virtual models, tiers and prices in the global config ([487c81d](https://github.com/ExaDev/agent-shim/commit/487c81dfbdcbb80e85272d4841efa0f52d94a420))

## [11.32.0](https://github.com/ExaDev/agent-shim/compare/v11.31.1...v11.32.0) (2026-10-17)

### Features

* **models:** add model identity, the selection engine and per-target observations ([cbb2a47](https://github.com/ExaDev/agent-shim/commit/cbb2a4731794d7c2971cff468176ea38aaa356bf))

## [11.31.1](https://github.com/ExaDev/agent-shim/compare/v11.31.0...v11.31.1) (2026-10-17)

### Bug Fixes

* **frontdoor:** serve routed requests and record them under the serving provider ([d80421e](https://github.com/ExaDev/agent-shim/commit/d80421e1775a75a3e29526e4cf605e365c3f1ac7))

## [11.31.0](https://github.com/ExaDev/agent-shim/compare/v11.30.0...v11.31.0) (2026-10-17)

### Features

* **antigravity:** add a virtual auto model that goes wherever there is quota ([4ea472f](https://github.com/ExaDev/agent-shim/commit/4ea472fa6987687499d038de96ce5292838fd5d8))

## [11.30.0](https://github.com/ExaDev/agent-shim/compare/v11.29.0...v11.30.0) (2026-10-17)

### Features

* **launcher:** explain a pool pick by listing every member it ranked ([177845a](https://github.com/ExaDev/agent-shim/commit/177845a2fcf2da62f7dd5132606e7ea49433b424))

## [11.29.0](https://github.com/ExaDev/agent-shim/compare/v11.28.0...v11.29.0) (2026-10-17)

### Features

* **launcher:** print a launch's facts as one aligned report ([0123259](https://github.com/ExaDev/agent-shim/commit/01232596f3671e5d54f6b931138e6cefe3704e32))

## [11.28.0](https://github.com/ExaDev/agent-shim/compare/v11.27.0...v11.28.0) (2026-10-17)

### Features

* **launcher:** hold a launch after its output so it can be read, by a delay or until a key press ([7499178](https://github.com/ExaDev/agent-shim/commit/74991788a9151e003da5718a14a3df750d2db2fd))

## [11.27.0](https://github.com/ExaDev/agent-shim/compare/v11.26.0...v11.27.0) (2026-10-17)

### Features

* **launcher:** collapse unclassified-entry warnings, drop the no-op farm line, colour the log ([bb90231](https://github.com/ExaDev/agent-shim/commit/bb902313ed3a428ca21ebbf9614e0b75e094ba3a))

## [11.26.0](https://github.com/ExaDev/agent-shim/compare/v11.25.0...v11.26.0) (2026-10-17)

### Features

* **provider:** list an http provider's own model catalogue in /model ([f195c8f](https://github.com/ExaDev/agent-shim/commit/f195c8f5140ca673ecfb62c934d20252b324f57e))

## [11.25.0](https://github.com/ExaDev/agent-shim/compare/v11.24.0...v11.25.0) (2026-10-17)

### Features

* **provider:** let a provider declare the models /model lists ([0999170](https://github.com/ExaDev/agent-shim/commit/0999170c35a77f7e06c08449433496bb955f17c4))

## [11.24.0](https://github.com/ExaDev/agent-shim/compare/v11.23.0...v11.24.0) (2026-10-17)

### Features

* **launcher:** list a provider's real models in /model ([255be6a](https://github.com/ExaDev/agent-shim/commit/255be6a4f389164214f9c50c7e7edd074886eff7))

## [11.23.0](https://github.com/ExaDev/agent-shim/compare/v11.22.0...v11.23.0) (2026-10-16)

### Features

* **launcher:** let a provider session run on an identity with no stored login ([c3b5a96](https://github.com/ExaDev/agent-shim/commit/c3b5a965be252e1c9c30c539d463c3a99b319801))

### Bug Fixes

* **doctor:** find an identity's login by the Keychain service name Claude Code uses ([50fa342](https://github.com/ExaDev/agent-shim/commit/50fa3428acf42a3fc8fc3a0b17148af235403315))
* **frontdoor:** wait for the main thread to pause as long as the caller says ([a0c1a14](https://github.com/ExaDev/agent-shim/commit/a0c1a143e37dee504354031dae4ccb56367a23ad)), references [#470](https://github.com/ExaDev/agent-shim/issues/470)

### Documentation

* **launcher:** describe how a provider session authenticates and what Remote Control needs ([27e22f7](https://github.com/ExaDev/agent-shim/commit/27e22f7914d10c354ec2d5778a59ea8e92573ad6))

## [11.22.0](https://github.com/ExaDev/agent-shim/compare/v11.21.1...v11.22.0) (2026-10-16)

### Features

* **frontdoor:** log the machine load and the main thread's frames when the watchdog fires ([b54e396](https://github.com/ExaDev/agent-shim/commit/b54e3961e330a11ff9d9aacec8a2f6d2c5e1fb66)), references [#470](https://github.com/ExaDev/agent-shim/issues/470)

## [11.21.1](https://github.com/ExaDev/agent-shim/compare/v11.21.0...v11.21.1) (2026-10-16)

### Bug Fixes

* **frontdoor:** wait for a stalled door to be gone before the replacement binds ([6019b51](https://github.com/ExaDev/agent-shim/commit/6019b51610dcfc682a4b1a2e38b50819ae89340c)), references [#469](https://github.com/ExaDev/agent-shim/issues/469)

## [11.21.0](https://github.com/ExaDev/agent-shim/compare/v11.20.1...v11.21.0) (2026-10-16)

### Features

* **statusline:** align the bars of every row on one grid ([8b4b834](https://github.com/ExaDev/agent-shim/commit/8b4b8342f6a1abd651359c3421335e3e9ebd3453))

## [11.20.1](https://github.com/ExaDev/agent-shim/compare/v11.20.0...v11.20.1) (2026-10-16)

### Bug Fixes

* **release:** always release a breaking commit as a major ([6f277fb](https://github.com/ExaDev/agent-shim/commit/6f277fb60af2789e7db93a0d2a48484eb4e9c386))

## [11.20.0](https://github.com/ExaDev/agent-shim/compare/v11.19.1...v11.20.0) (2026-10-16)

### Features

* **launcher:** let a supervising launcher fix a launch's session id, conversation and member ([039a2e8](https://github.com/ExaDev/agent-shim/commit/039a2e825b9bbafdeeb63f98300a7e179f2322ac))
* **pool:** add settings for compacting a pool's sessions before their member runs out ([d556eef](https://github.com/ExaDev/agent-shim/commit/d556eef1515c9596e8964807bcfa4c6d7f9f3d35))
* **pool:** resume a session under the next member when its identity runs out of quota ([282ce84](https://github.com/ExaDev/agent-shim/commit/282ce8486e493e7f38fe2ddbcfb9ff13c4c00b3d))
* **supervise:** compact a session's context before its member's quota is spent ([dfad0dc](https://github.com/ExaDev/agent-shim/commit/dfad0dc80e42665c3177a81a12cb76e95026320f))
* **supervise:** record when a supervised session's turns begin and end ([6afe8b3](https://github.com/ExaDev/agent-shim/commit/6afe8b3286bbdeebfa77cccb211e77db8beba486))
* **usage:** leave room for context already moving onto a member when ranking ([b1bf9ee](https://github.com/ExaDev/agent-shim/commit/b1bf9ee82b895186108006a6eb4450095ec41c6b))

## [11.19.1](https://github.com/ExaDev/agent-shim/compare/v11.19.0...v11.19.1) (2026-10-16)

### ⚠ BREAKING CHANGES

* **pool:** the library's `setPool` is replaced by `changePool(paths, name, change)`,
  and `addPool` takes a policy object, `{ preference }`, as its fourth argument instead of
  a preference string.

### Code Refactoring

* **pool:** change a pool through one store function taking a policy object ([8822805](https://github.com/ExaDev/agent-shim/commit/8822805b30aaf3100b5dda51be8517bd37cc8433))

### Continuous Integration

* let a release whose npm publish already landed carry on to its later jobs ([1c11ba1](https://github.com/ExaDev/agent-shim/commit/1c11ba16a14fa6d0932d2fd47c5bf4b1b16cf627))

## [11.19.0](https://github.com/ExaDev/agent-shim/compare/v11.18.0...v11.19.0) (2026-10-16)

### Features

* **config:** warn and ignore a setting this release does not know instead of failing the file ([653a7b6](https://github.com/ExaDev/agent-shim/commit/653a7b685a077ce85d928ab83c13c193204bee11))

## [11.18.0](https://github.com/ExaDev/agent-shim/compare/v11.17.1...v11.18.0) (2026-10-16)

### Features

* **antigravity:** add a setting that degrades a spent tier down the lower tiers ([81d3146](https://github.com/ExaDev/agent-shim/commit/81d3146f75010ea8162299f8083841accb3b82d4))
* **antigravity:** give the fable tier Gemini 4 Argon first and drop GPT-OSS as a fallback ([1edfa49](https://github.com/ExaDev/agent-shim/commit/1edfa49b4cacf26bc73675f9b098d6e1dac719dd))

### Code Refactoring

* **antigravity:** stop exporting a stage builder only its own module uses ([7607e94](https://github.com/ExaDev/agent-shim/commit/7607e94a10017273cfb7b31b41b773f81409614b))

## [11.17.1](https://github.com/ExaDev/agent-shim/compare/v11.17.0...v11.17.1) (2026-10-16)

### Bug Fixes

* **antigravity:** send tool schemas to the backend as whole JSON Schema ([f67bd8b](https://github.com/ExaDev/agent-shim/commit/f67bd8b01d779f4275783a86ba7b99d2b9a653e7))

## [11.17.0](https://github.com/ExaDev/agent-shim/compare/v11.16.0...v11.17.0) (2026-10-16)

### Features

* **antigravity:** keep a session on its routed model and spend running windows first ([cad604b](https://github.com/ExaDev/agent-shim/commit/cad604bc946c580edb026d8958c86c03d40469c6))
* **antigravity:** lead the opus and sonnet tiers with their matching Claude model ([c10ff8c](https://github.com/ExaDev/agent-shim/commit/c10ff8ce6b6078b766ee0f574e577c063753049e))
* **antigravity:** rank fallback candidates by the allowance their windows would lose ([c44d3d6](https://github.com/ExaDev/agent-shim/commit/c44d3d6d1a56b120ad54eda5526084aa04428445))
* **antigravity:** route a tier or alias across candidate models by available quota ([1ca0f70](https://github.com/ExaDev/agent-shim/commit/1ca0f70aafa9c85cf22021a77c56b4528ab7de5d))
* **antigravity:** ship quota routing across model families as the tier default ([ff15c97](https://github.com/ExaDev/agent-shim/commit/ff15c9725545c2da6982317cbf0f5ce900a563e8))

### Code Refactoring

* **antigravity:** stop exporting two names only their own modules use ([c458e5e](https://github.com/ExaDev/agent-shim/commit/c458e5e66090c181eabccf088ce5279f5b7248f8))

## [11.16.0](https://github.com/ExaDev/agent-shim/compare/v11.15.0...v11.16.0) (2026-10-16)

### Features

* **antigravity:** select any backend model with /model, and map names with aliases ([9fc8737](https://github.com/ExaDev/agent-shim/commit/9fc8737f451b575ebe859b20e1ce66d58f7cf5fa))
* **statusline:** draw every Antigravity model family's quota window ([f7dae82](https://github.com/ExaDev/agent-shim/commit/f7dae82da753dc9ef837fbf8cc897abae5287489))

## [11.15.0](https://github.com/ExaDev/agent-shim/compare/v11.14.0...v11.15.0) (2026-10-16)

### Features

* **statusline:** colour the cache hit percentage by its band ([d0e93a8](https://github.com/ExaDev/agent-shim/commit/d0e93a89493d70563dc2b20f7886b041cf3bd785))
* **statusline:** show what headroom saved the session ([bc083c4](https://github.com/ExaDev/agent-shim/commit/bc083c49b31458efe1afe93d772119be7b2c5529)), closes [#447](https://github.com/ExaDev/agent-shim/issues/447)

### Bug Fixes

* **antigravity:** report Gemini 4 Argon from its own weekly window ([71c0a1d](https://github.com/ExaDev/agent-shim/commit/71c0a1d7fa3de777ff762c0fb70cc17533371a1c))
* **antigravity:** sign a tool call the door never saw with the backend's bypass value ([dd2a7dc](https://github.com/ExaDev/agent-shim/commit/dd2a7dc755384475de80d9b46d0aaf7472cd1623))
* **antigravity:** translate a quota rejection into the limit it is ([a033284](https://github.com/ExaDev/agent-shim/commit/a033284de02d69d34eb1a79ec50ee52f8a8cb4d3))
* **statusline:** show the headroom saving percentage with readable precision ([51c0827](https://github.com/ExaDev/agent-shim/commit/51c08278ed92320deb6586d51a2c64933092a718))

### Code Refactoring

* stop exporting a headroom timeout and a quota window type only their own modules use ([b274bc9](https://github.com/ExaDev/agent-shim/commit/b274bc90e56eafa75d6df376ca2f6697d71c878a))

### Documentation

* describe the statusline's headroom segment ([a72f06c](https://github.com/ExaDev/agent-shim/commit/a72f06cf3dd06000884e48d84fee87a94c3848d0))

## [11.14.0](https://github.com/ExaDev/agent-shim/compare/v11.13.0...v11.14.0) (2026-10-16)

### Features

* **statusline:** leave the model out when stacked under the Antigravity CLI's line ([a6d8eda](https://github.com/ExaDev/agent-shim/commit/a6d8edad4642375549c70fb60a8781117fb0760e))
* **statusline:** read a providerless session's quota from the client's payload ([7a5bb2a](https://github.com/ExaDev/agent-shim/commit/7a5bb2a28885304876eb73544620831300f33aff)), closes [#446](https://github.com/ExaDev/agent-shim/issues/446)
* **statusline:** read the login account from the session's own profile file ([4544612](https://github.com/ExaDev/agent-shim/commit/4544612a0baacdc8af8df1a60b0f2b7206e6e7fc))
* **statusline:** render the Antigravity CLI's payload ([3882e57](https://github.com/ExaDev/agent-shim/commit/3882e57a83ab62d5a6a6bdc4f929438272cc0e63))

### Bug Fixes

* **statusline:** show a provider session's own usage, never another provider's ([f1a0693](https://github.com/ExaDev/agent-shim/commit/f1a0693e1375ee1aa3b71dc3232efefda3666e8c))

### Code Refactoring

* **antigravity:** share the five-hour and weekly bucket selection ([b4f2e8d](https://github.com/ExaDev/agent-shim/commit/b4f2e8dfe83072ea800d6d77d8eb3c1d1a93b121))
* **statusline:** stop exporting a quota window view only its own module uses ([02bb735](https://github.com/ExaDev/agent-shim/commit/02bb73581fe43c9ff8bdf90b36ff676680a20079))

### Documentation

* describe the statusline for a session outside agent-shim ([e3c4b43](https://github.com/ExaDev/agent-shim/commit/e3c4b43788203776bbb1b23f013b079a5c1a2c97))
* document the statusline under the Antigravity CLI ([dbe3ea3](https://github.com/ExaDev/agent-shim/commit/dbe3ea332303dbd3830f724cc52f30b698af037e))
* note that the statusline reads the Antigravity CLI's stacking setting ([49d6ac2](https://github.com/ExaDev/agent-shim/commit/49d6ac2f3e8009e4c5515049d9edcecdbd709112))

## [11.13.0](https://github.com/ExaDev/agent-shim/compare/v11.12.0...v11.13.0) (2026-10-16)

### Features

* **statusline:** justify the header's segments across the line ([3d72cbc](https://github.com/ExaDev/agent-shim/commit/3d72cbc432d4a40a97f3820ee51531a1e86f60ef))
* **statusline:** name the login account's plan from its organisation and seat ([a3cabed](https://github.com/ExaDev/agent-shim/commit/a3cabed194021303bba54bf4488cc05fb57d1bdb))
* **statusline:** show the OAuth login account and plan beside the provider's ([f647945](https://github.com/ExaDev/agent-shim/commit/f6479455487778881294e2d3058e38d5dad071b2))
* **statusline:** show the provider account, plan and identity on the first line ([f7b4a49](https://github.com/ExaDev/agent-shim/commit/f7b4a4961ad2eef699094a4d255e0485b85dea4d))
* **usage:** read the antigravity account's subscription tier ([7880ebe](https://github.com/ExaDev/agent-shim/commit/7880ebeca4ad7ddd541e4be1a7d7f7c02f55ec62))

### Bug Fixes

* **statusline:** wrap the first line instead of losing its tail ([63cc76f](https://github.com/ExaDev/agent-shim/commit/63cc76f918ef41cbfa1c355702190b2a20463114))
* **usage:** take the antigravity plan from the paid tier, not the code-assist default ([0560fcd](https://github.com/ExaDev/agent-shim/commit/0560fcd94754a97a755981941467c9b06e13a758))

### Code Refactoring

* **statusline:** drop the identity segment from a providerless line ([e9f5d72](https://github.com/ExaDev/agent-shim/commit/e9f5d721b653b862742f6a642018e0abc2b72c80))
* **statusline:** name a provider session's login by its organisation, not its plan ([46f3db1](https://github.com/ExaDev/agent-shim/commit/46f3db1ce367c4eb4ca706fb075bc52ccd506360))
* **statusline:** pack wrapped segments greedily ([0468975](https://github.com/ExaDev/agent-shim/commit/0468975913cc56a46b11341fa8d90b06a71546e0))

## [11.12.0](https://github.com/ExaDev/agent-shim/compare/v11.11.0...v11.12.0) (2026-10-16)

### Features

* **antigravity:** honour a model name's 1m context marker ([bff2aa1](https://github.com/ExaDev/agent-shim/commit/bff2aa19a9f37db97db3d5020db1ac20e67a2f50))
* **cli:** add a statusline entrypoint that enriches and delegates ([dd4acb3](https://github.com/ExaDev/agent-shim/commit/dd4acb305148a581753995bc6f5e5a435bfbd8f2))
* **statusline:** render the built-in line in the Antigravity statusline's own idiom ([9e4f8ad](https://github.com/ExaDev/agent-shim/commit/9e4f8ad19a5049b97cdb115e35187afd5815b895))
* **statusline:** show the model and the prompt cache's hit percentage ([37078e9](https://github.com/ExaDev/agent-shim/commit/37078e9c4074ac8af5345f891b39aa39c6e0317b))

### Bug Fixes

* **antigravity:** report Gemini's implicit cache reads in the usage block ([12fecb5](https://github.com/ExaDev/agent-shim/commit/12fecb51aa78cea5b3197f8cf03c7bbcea443c56))
* **antigravity:** report utilization as the fraction the real API uses ([6b25c42](https://github.com/ExaDev/agent-shim/commit/6b25c42b945d0e1d113cf885bdb5c3697c3d7b24))
* **antigravity:** stop a quota-cache-cold response erasing the known windows ([a3b2934](https://github.com/ExaDev/agent-shim/commit/a3b29343d2f20de6e43ea82c33f1a97beda4928c))
* **statusline:** fit the built-in line inside Claude Code's status line width ([94c37d5](https://github.com/ExaDev/agent-shim/commit/94c37d5add2c1e3225ab285dcef6288b9e147855))

### Code Refactoring

* **statusline:** give the model the first line to itself ([dca286a](https://github.com/ExaDev/agent-shim/commit/dca286a0ce28cce0e34c53ceeb5aa63f85aa0a72))

### Continuous Integration

* retry an artifact upload once after a transient failure ([cd54ce0](https://github.com/ExaDev/agent-shim/commit/cd54ce0d7f935a113bef0fb9d4956477761d83a3))

## [11.11.0](https://github.com/ExaDev/agent-shim/compare/v11.10.0...v11.11.0) (2026-10-16)

### Features

* **usage:** record an antigravity provider's own account and quota windows ([7728932](https://github.com/ExaDev/agent-shim/commit/7728932bf1ba75ad56e1429d390f8982535c1c48))

### Bug Fixes

* **usage:** attribute a provider session's bare requests to its provider ([6388f89](https://github.com/ExaDev/agent-shim/commit/6388f89e1af8809c38c3a12c98c03e8876a4a077))

## [11.10.0](https://github.com/ExaDev/agent-shim/compare/v11.9.0...v11.10.0) (2026-10-16)

### Features

* **antigravity:** complete a bare family member with the request's effort suffix ([745c04c](https://github.com/ExaDev/agent-shim/commit/745c04c81e2024c2f09514aa176a0788fff4a8a5))
* **antigravity:** map every tier onto a Gemini 3.8 flash model ([c2924a7](https://github.com/ExaDev/agent-shim/commit/c2924a773365f8e146e87b374bc435acb36cf677))
* **antigravity:** poll the backend quota summary onto response headers ([cada64a](https://github.com/ExaDev/agent-shim/commit/cada64aa687dc8038885d9f67f76eea80f5e781e))
* **antigravity:** route cloud mode through the Cloud Code proxy endpoint ([ca3760e](https://github.com/ExaDev/agent-shim/commit/ca3760ecf1a683b228de4974dff9a6dbf704ac7f))

### Bug Fixes

* **antigravity:** echo the backend's thought signatures through tool turns ([7b83b4f](https://github.com/ExaDev/agent-shim/commit/7b83b4fe6153957b2786551a209525590a1424a2))
* **antigravity:** translate tool input schemas onto the Cloud Code subset ([f43b209](https://github.com/ExaDev/agent-shim/commit/f43b2098b72fdb6b7ab6775d7416fbb22515bd2f))
* **credential:** unwrap go-keyring-base64 token envelopes ([a3681d5](https://github.com/ExaDev/agent-shim/commit/a3681d575f6b791573a3b6e7c7496fc5e0f5de5c))
* **frontdoor:** scope a provider session's bare /v1/ target before the route serves ([9076630](https://github.com/ExaDev/agent-shim/commit/90766303f562f5ff34909dc78b1a8a247c984bdd))

### Continuous Integration

* **husky:** automate schema regeneration on commit and add typecheck to pre-commit ([b097001](https://github.com/ExaDev/agent-shim/commit/b097001f584d2080f28fe202c9302750903b0ca3))

### Tests

* **antigravity:** cover the xhigh and max effort budgets and the fallback ([644e390](https://github.com/ExaDev/agent-shim/commit/644e3903604bbb5adcd73413433cf6100e80bd7e))

## [11.9.0](https://github.com/ExaDev/agent-shim/compare/v11.8.2...v11.9.0) (2026-10-15)

### Features

* **antigravity:** implement request translation, stream relay, and upstreams ([2ace4c3](https://github.com/ExaDev/agent-shim/commit/2ace4c3eb1feb8bf7c32a858d0fd5465e3e241ec))
* **antigravity:** translate quota to anthropic unified rate-limit headers ([76b6ce8](https://github.com/ExaDev/agent-shim/commit/76b6ce874b11a5f6b6582e4bea4044b2431bc7e2))
* **config:** add antigravity provider schema and configuration types ([4d540ca](https://github.com/ExaDev/agent-shim/commit/4d540caae0887f1a0e723ab5b5243d731d988d5e))
* **frontdoor:** mount antigravity provider routes ([6b7b27a](https://github.com/ExaDev/agent-shim/commit/6b7b27ae3b6b4e962953647dbe67f49ea3e0bd4a))
* **providers:** add antigravity provider cli commands and store support ([c49f2dc](https://github.com/ExaDev/agent-shim/commit/c49f2dcbf8e3eef977476ce63df9a86ec204140d))

### Bug Fixes

* **antigravity:** emit full token usage and normalize finish reasons ([63d76d9](https://github.com/ExaDev/agent-shim/commit/63d76d93b62145bfd979d1a3df20d6e5fa29396f))

### Code Refactoring

* **antigravity:** remove unused acpSchema and unexport internal types ([33d95d5](https://github.com/ExaDev/agent-shim/commit/33d95d595d575c92df82cf1aa1d451962356adaf))
* **codex:** make usage snapshot sidecar write optional ([6e93ed8](https://github.com/ExaDev/agent-shim/commit/6e93ed800b643f9404d7d1a4c0b31051c6824c33))

### Continuous Integration

* **husky:** add schema check and knip to pre-push hook ([06cb555](https://github.com/ExaDev/agent-shim/commit/06cb5555306147b43c7278179ad01d61ced7b6de))
* **husky:** run typecheck before tests in pre-push hook ([0149dc7](https://github.com/ExaDev/agent-shim/commit/0149dc7dcdc91d02a886b8d5dada30743d1f1659))

## [11.8.2](https://github.com/ExaDev/agent-shim/compare/v11.8.1...v11.8.2) (2026-10-14)

### Bug Fixes

* **frontdoor:** log every exit and replace a door its watchdog ended ([61fd5fd](https://github.com/ExaDev/agent-shim/commit/61fd5fd2eb21424851ae7a3078b1a5a655cf4b97))

## [11.8.1](https://github.com/ExaDev/agent-shim/compare/v11.8.0...v11.8.1) (2026-10-13)

### Bug Fixes

* **frontdoor:** stop opting sessions into headroom's mid-turn queueing ([62f3293](https://github.com/ExaDev/agent-shim/commit/62f3293ccb53b13a2770915c7dbaa29661ca0ec5))

## [11.8.0](https://github.com/ExaDev/agent-shim/compare/v11.7.0...v11.8.0) (2026-10-13)

### Features

* **doctor:** probe both front door listeners instead of trusting the supervisor pid ([eebec5b](https://github.com/ExaDev/agent-shim/commit/eebec5b7401842644a0c384e30ce9439ffef9f89)), references [#428](https://github.com/ExaDev/agent-shim/issues/428)

## [11.7.0](https://github.com/ExaDev/agent-shim/compare/v11.6.2...v11.7.0) (2026-10-13)

### Features

* **frontdoor:** end a door whose event loop has stopped running ([cf8c5d5](https://github.com/ExaDev/agent-shim/commit/cf8c5d5c314a9c9923828b80f8fb090c3475f20d)), references [#427](https://github.com/ExaDev/agent-shim/issues/427)

### Bug Fixes

* **frontdoor:** keep the stall action type private to the watchdog ([182bd99](https://github.com/ExaDev/agent-shim/commit/182bd993f1c5c29013d39ef933a38e53e640ff58))
* **frontdoor:** make the watchdog port optional for in-process hosts ([990779b](https://github.com/ExaDev/agent-shim/commit/990779bfc10d10bead0bed73cf89ee401c93d891)), references [#427](https://github.com/ExaDev/agent-shim/issues/427)

## [11.6.2](https://github.com/ExaDev/agent-shim/compare/v11.6.1...v11.6.2) (2026-10-13)

### Bug Fixes

* **usage:** never open a window for an account whose quota has not been read ([a2519e5](https://github.com/ExaDev/agent-shim/commit/a2519e527e68dd07134fed9b0242615c81c8060d))

## [11.6.1](https://github.com/ExaDev/agent-shim/compare/v11.6.0...v11.6.1) (2026-10-13)

### Bug Fixes

* **frontdoor:** never ask ps or probe the door's own held event loop ([8cee855](https://github.com/ExaDev/agent-shim/commit/8cee855361c042d675bb97042fd636de8d742969))

### Tests

* **usage:** fail a launch planned inside the door at its first wait ([767f9a5](https://github.com/ExaDev/agent-shim/commit/767f9a5e6316b739a88d04d70880cd5a70b81c93)), references [#429](https://github.com/ExaDev/agent-shim/issues/429)

## [11.6.0](https://github.com/ExaDev/agent-shim/compare/v11.5.2...v11.6.0) (2026-10-12)

### Features

* **frontdoor:** refuse synchronous launcher coordination in the door process ([f98d231](https://github.com/ExaDev/agent-shim/commit/f98d2314f30515ab9e8db025339e17b9553bb623)), references [#426](https://github.com/ExaDev/agent-shim/issues/426)

## [11.5.2](https://github.com/ExaDev/agent-shim/compare/v11.5.1...v11.5.2) (2026-10-12)

### Bug Fixes

* **frontdoor:** confirm the process before the in-door shortcut ([0737dae](https://github.com/ExaDev/agent-shim/commit/0737dae7b0db9959753c00a59a26b236321063b0)), references [#424](https://github.com/ExaDev/agent-shim/issues/424)
* **frontdoor:** let an explicit replace retire a door that is not answering ([4fa0960](https://github.com/ExaDev/agent-shim/commit/4fa0960705fc076dd7e974f6d1d5ac0fe0c4715e)), references [#424](https://github.com/ExaDev/agent-shim/issues/424)
* **frontdoor:** never probe the door a launch is planned inside ([006106f](https://github.com/ExaDev/agent-shim/commit/006106f990ac9221dbb09bca0a405dd4827aebe7)), references [#424](https://github.com/ExaDev/agent-shim/issues/424)

## [11.5.1](https://github.com/ExaDev/agent-shim/compare/v11.5.0...v11.5.1) (2026-10-12)

### Bug Fixes

* **frontdoor:** never retire a door that has live sessions on a missed probe ([d51ea33](https://github.com/ExaDev/agent-shim/commit/d51ea3304848f47b7ef6ee96a7ab2a4caf7de8ce)), references [#420](https://github.com/ExaDev/agent-shim/issues/420)

## [11.5.0](https://github.com/ExaDev/agent-shim/compare/v11.4.1...v11.5.0) (2026-10-12)

### Features

* **frontdoor:** match each response with its own thread's previous one ([da9e5e9](https://github.com/ExaDev/agent-shim/commit/da9e5e96c4f2e4858aef0091a3788cf91b181962))
* **frontdoor:** take a session off headroom when it breaks the session's prefix ([57f51be](https://github.com/ExaDev/agent-shim/commit/57f51be75011bedb4891fde5a685d35581f2e997))

### Bug Fixes

* **frontdoor:** bound the messages body the pipeline reads whole ([846b66a](https://github.com/ExaDev/agent-shim/commit/846b66a553516ad15ac88aafb9b890fd88bb46f9))
* **frontdoor:** budget a body's lexical tokens when hashing its thread ([2ce1d36](https://github.com/ExaDev/agent-shim/commit/2ce1d3667863539f6f244cfbb8bc4f9667d0eb91))
* **frontdoor:** cap the work a body's lineage costs ([e0f6c51](https://github.com/ExaDev/agent-shim/commit/e0f6c513a803fdd65bd2f88f4381c5af38ebca81))
* **frontdoor:** carry a request's thread on its response, not in a map ([0acf6ec](https://github.com/ExaDev/agent-shim/commit/0acf6ecd8b96318f0b4effa9e65ab484254e6dd6))
* **frontdoor:** compare a response only with its own session's threads ([76261bd](https://github.com/ExaDev/agent-shim/commit/76261bdc6e5f1b49b9cc22b90d8c4ebba1783701))
* **frontdoor:** give a deeply nested body no lineage ([3291492](https://github.com/ExaDev/agent-shim/commit/32914923d58ac1af0221b5f67fead244f00757b0))
* **frontdoor:** hash a request's thread without parsing its body ([10c7981](https://github.com/ExaDev/agent-shim/commit/10c798108f6ceb5c99a9fb989e5fa8051e251823))
* **frontdoor:** read the thread from the hop's own body, bounded ([1a17fd9](https://github.com/ExaDev/agent-shim/commit/1a17fd9a1ade735a79aa91ab4804a3f95e0a0835))

## [11.4.1](https://github.com/ExaDev/agent-shim/compare/v11.4.0...v11.4.1) (2026-10-12)

### Bug Fixes

* **headroom:** pin the default install source to the reconciled fork ([d64d161](https://github.com/ExaDev/agent-shim/commit/d64d16146f6cf627f32ad38c7f061efde23db540)), references [#382](https://github.com/ExaDev/agent-shim/issues/382) [#403](https://github.com/ExaDev/agent-shim/issues/403)

## [11.4.0](https://github.com/ExaDev/agent-shim/compare/v11.3.0...v11.4.0) (2026-10-12)

### Features

* **frontdoor:** treat a small or compacted context as a cache boundary ([c699d21](https://github.com/ExaDev/agent-shim/commit/c699d21943ae78880b3f8e80e09b74afd49bf1d4))

## [11.3.0](https://github.com/ExaDev/agent-shim/compare/v11.2.0...v11.3.0) (2026-10-12)

### Features

* **headroom:** enable or disable routing live, globally or per session ([f091127](https://github.com/ExaDev/agent-shim/commit/f0911275885c34b57e37e87066d6a8699ebf6000))
* **pool:** weigh a resumed conversation's context size when picking ([d0e8bab](https://github.com/ExaDev/agent-shim/commit/d0e8babfdd7307c99cdcb4c9aaeb48f2b6e3cc4b))

## [11.2.0](https://github.com/ExaDev/agent-shim/compare/v11.1.0...v11.2.0) (2026-10-12)

### Features

* **frontdoor:** send a session direct while headroom is unavailable ([b6c408d](https://github.com/ExaDev/agent-shim/commit/b6c408df2f273b88891aa0bf775138364c464633))

## [11.1.0](https://github.com/ExaDev/agent-shim/compare/v11.0.0...v11.1.0) (2026-10-12)

### Features

* **frontdoor:** decide headroom once per session and keep it while its cache is warm ([7f1c715](https://github.com/ExaDev/agent-shim/commit/7f1c7157d23fb434f4b6a230cc4c6c40dd78d3c7))

### Code Refactoring

* **frontdoor:** keep the observed response shape private to the decision ([9fade20](https://github.com/ExaDev/agent-shim/commit/9fade20a9bea36e3125f874d8169845914dfff9d))

## [11.0.0](https://github.com/ExaDev/agent-shim/compare/v10.1.0...v11.0.0) (2026-10-12)

### ⚠ BREAKING CHANGES

* **launcher:** a launch with no provider, headroom or usage setting now depends on the front
  door being up. Opt out with --no-track-usage, AGENT_SHIM_TRACK_USAGE=0, launch.trackUsage:
  false in a profile, rule or the global config, or run with --native.

### Features

* **launcher:** engage the front door for every launch by default ([5bd9cc1](https://github.com/ExaDev/agent-shim/commit/5bd9cc1e3bb488b6e3165ad5a993f3547c4c112a))

## [10.1.0](https://github.com/ExaDev/agent-shim/compare/v10.0.2...v10.1.0) (2026-10-12)

### Features

* **usage:** record whether each request crossed headroom ([b8a788f](https://github.com/ExaDev/agent-shim/commit/b8a788fbecc160008f65c4aaec13603aab366c58))

## [10.0.2](https://github.com/ExaDev/agent-shim/compare/v10.0.1...v10.0.2) (2026-10-12)

### Bug Fixes

* keep a launch waiting while the headroom supervisor installs ([faed4c6](https://github.com/ExaDev/agent-shim/commit/faed4c6540e91e20381a3d330ee0573f71a663e6)), references [#403](https://github.com/ExaDev/agent-shim/issues/403)

## [10.0.1](https://github.com/ExaDev/agent-shim/compare/v10.0.0...v10.0.1) (2026-10-12)

### Bug Fixes

* **frontdoor:** say which attempt failed and whether the client was waiting ([d5a7b8e](https://github.com/ExaDev/agent-shim/commit/d5a7b8ea16f24c6d24239dd81971fc634d906df1))

## [10.0.0](https://github.com/ExaDev/agent-shim/compare/v9.19.1...v10.0.0) (2026-10-12)

### ⚠ BREAKING CHANGES

* **headroom:** ensureHeadroom takes requiredUpstreams in place of
  requiredAllowlistHash, and launchRequiredUpstreams is exported to compute it.
  EnsureHeadroomPorts gains daemonCommandLine. SupervisorPorts.spawnHeadroom
  takes the allowlist file path in place of the allowlist; SupervisorPorts
  gains daemonCommandLine, frontDoorLiveness, daemonLogSize and
  readDaemonLogTail; SupervisorPorts.socketTrust gains readlink, and its lstat
  must report a regular file as the new SocketPathStat kind "file".
  RunDoctorParams.headroom.allowlist is now { drift, file, logPath,
  undeterminedFrontDoors, fileProblem }, where fileProblem is
  { message, repairable }, and RunDoctorParams.frontDoor gains liveSessions.
  headroom status --json replaces allowlistDrifted, allowlistDriftInputs and
  frontDoorOrigin with allowlistFile, allowlistDrift, allowlistFileProblem
  ({ message, repairable }) and undeterminedFrontDoors. The daemon must be a
  headroom build that accepts --allowed-base-urls-file; the default
  headroom.source moves to commit ca7589c5 on the ExaDev headroom fork's main,
  which carries it. An agent-shim root
  whose ancestors fail headroom's rule, such as one under /tmp, can no longer
  route through headroom.

### Features

* **headroom:** serve the allowlist from a file headroom re-reads ([c351b6c](https://github.com/ExaDev/agent-shim/commit/c351b6c94cee5d60bafdf3f196fac090c8eb0088))

### Documentation

* describe the headroom allowlist file and the waiting launch gate ([1d4ad0c](https://github.com/ExaDev/agent-shim/commit/1d4ad0cceb65755822903f14a4c12c1a255434f2))

## [9.19.1](https://github.com/ExaDev/agent-shim/compare/v9.19.0...v9.19.1) (2026-10-12)

### Documentation

* record the Claude Code version the Remote Control task event shapes were read from ([2136326](https://github.com/ExaDev/agent-shim/commit/21363267123844e60a06afbd18b43902d81ba6b3))

## [9.19.0](https://github.com/ExaDev/agent-shim/compare/v9.18.0...v9.19.0) (2026-10-12)

### Features

* merge live Remote Control task events into the agent tree ([47bdfed](https://github.com/ExaDev/agent-shim/commit/47bdfed929724e716945f5d8f4358a2e12edf5ee))

### Bug Fixes

* run window openings and jobs in a child process, not inside the front door ([574a79d](https://github.com/ExaDev/agent-shim/commit/574a79d455f48766d05a69ab386037f0a864da98))

## [9.18.0](https://github.com/ExaDev/agent-shim/compare/v9.17.0...v9.18.0) (2026-10-11)

### Features

* gate the MCP server's reads of session history behind their own grant ([179de1d](https://github.com/ExaDev/agent-shim/commit/179de1d981e2ce2c33f333ccfdeb7362f29c3a72))
* hold a --wait launch for a member that returns before the pick would run dry ([a8c8a73](https://github.com/ExaDev/agent-shim/commit/a8c8a738c25ee2990a6ab0fb0fd2184bb4e6abd2))
* serve the agent tree on the door's typed API ([037b0ac](https://github.com/ExaDev/agent-shim/commit/037b0ac5e02545680e5ccb44045c53e5e0d40cfb))

### Bug Fixes

* drop the unused session summary view type ([9d90d2f](https://github.com/ExaDev/agent-shim/commit/9d90d2f02f92e8462d675ea6f04faded35d9cbe2))

## [9.17.0](https://github.com/ExaDev/agent-shim/compare/v9.16.0...v9.17.0) (2026-10-11)

### Features

* add session list and show commands ([9281914](https://github.com/ExaDev/agent-shim/commit/928191425d574d64e5daa74b313eac9ca91be532))

## [9.16.0](https://github.com/ExaDev/agent-shim/compare/v9.15.1...v9.16.0) (2026-10-11)

### Features

* read a session's agent tree from the transcripts on disk ([104136e](https://github.com/ExaDev/agent-shim/commit/104136e3df5defa2db55ce39aa311f223cbff95b))

### Bug Fixes

* keep depth-less parents eligible and read caller-named task lists in the agent tree ([f44cc16](https://github.com/ExaDev/agent-shim/commit/f44cc169c592d3b1c0290eb7255e22d8fc37eb34))
* keep task metadata and describe the recorded model accurately in the agent tree ([4dd39cf](https://github.com/ExaDev/agent-shim/commit/4dd39cfdbb262cbaaefaaf373e6534bbae688e9c))
* keep the problem schema private to the agent tree schema ([fe7658c](https://github.com/ExaDev/agent-shim/commit/fe7658ccbbdeb8f882c0cee0a1a06fe08426350f))
* read the session-prefixed task list and keep task owners in the agent tree ([8f88271](https://github.com/ExaDev/agent-shim/commit/8f8827134dfb20d8191f28a56beb2ccf6290f26a))
* tolerate unreadable files and read team task stores in the agent tree ([acacae7](https://github.com/ExaDev/agent-shim/commit/acacae7d76f1f1315463083b3bfeeab333345e81))

## [9.15.1](https://github.com/ExaDev/agent-shim/compare/v9.15.0...v9.15.1) (2026-10-11)

### Bug Fixes

* report an errored SDK turn as a failure and keep the door up on an unreadable config ([d448e2a](https://github.com/ExaDev/agent-shim/commit/d448e2ad4b7a6df3489749e8c67b3fcb6feb08dd))
* treat a window's reset reported a fraction of a second apart as one instance ([a70c4fd](https://github.com/ExaDev/agent-shim/commit/a70c4fdeeb45e0a99cdaa74709daf990a464f9ee))

## [9.15.0](https://github.com/ExaDev/agent-shim/compare/v9.14.0...v9.15.0) (2026-10-11)

### Features

* run prompts unattended on a schedule or shortly before a quota window resets ([59af33b](https://github.com/ExaDev/agent-shim/commit/59af33bfa203f85de761258a31339152f7cceb41))

### Bug Fixes

* load only the user's settings in an unattended job run ([1a123d2](https://github.com/ExaDev/agent-shim/commit/1a123d28c9d67bcf0852456d8cf7931bec9d3b63))
* start no MCP server in an unattended job run ([10339c9](https://github.com/ExaDev/agent-shim/commit/10339c9f8ea972ea57fead0cd5369c80d3ac8e3e))

### Documentation

* list the reset-timing modules in the architecture layout ([35e43eb](https://github.com/ExaDev/agent-shim/commit/35e43ebc045a41669a56e4cd166a1a3f1baae484))

## [9.14.0](https://github.com/ExaDev/agent-shim/compare/v9.13.0...v9.14.0) (2026-10-11)

### Features

* open an identity's five-hour window at its anchors ([b87aee0](https://github.com/ExaDev/agent-shim/commit/b87aee007675c60aef9a803be62067ca18459baa))

### Bug Fixes

* keep unattended identity runs off configured providers ([33bf4ea](https://github.com/ExaDev/agent-shim/commit/33bf4ea3a0a114ee33f805a60b1c02fb6244e4e8))

## [9.13.0](https://github.com/ExaDev/agent-shim/compare/v9.12.1...v9.13.0) (2026-10-11)

### Features

* drain and exit a front door superseded by another live supervisor ([dc2d341](https://github.com/ExaDev/agent-shim/commit/dc2d34152838e81c927a8ae6824dadae57ea7100)), references [#371](https://github.com/ExaDev/agent-shim/issues/371)
* hold a --wait launch for an exhausted plan to return instead of spending extra usage ([4a43360](https://github.com/ExaDev/agent-shim/commit/4a4336056860c9b3e91bb3d2189fe313e9d81668))
* record which door a launch was sent to and drain on that door's sessions only ([ef9da01](https://github.com/ExaDev/agent-shim/commit/ef9da01b72c98def998fa23370e1f01020620c82))
* report duplicate front doors and an allowlist that excludes the serving door ([daab002](https://github.com/ExaDev/agent-shim/commit/daab002a357b26aaded658388ed343f193813bbd))

### Code Refactoring

* read the front-door supervisor identity through the shared process parser ([25be7d4](https://github.com/ExaDev/agent-shim/commit/25be7d42d27cfdee9c67b1d79f6324255e93d5e2))

## [9.12.1](https://github.com/ExaDev/agent-shim/compare/v9.12.0...v9.12.1) (2026-10-11)

### Bug Fixes

* retire an unresponsive front door instead of spawning a second beside it ([1817a11](https://github.com/ExaDev/agent-shim/commit/1817a11774109f536cd9093f258acf0e5e21e60b))

### Documentation

* describe how an unresponsive front door is retired before its replacement starts ([8990e8e](https://github.com/ExaDev/agent-shim/commit/8990e8e62ecd9b6dc94ad812ab5aa925193b6bd4))
* describe how Claude Code lays out agents and tasks on disk ([2b82286](https://github.com/ExaDev/agent-shim/commit/2b822864539d06423546b366f387a9c2beccb2fb))

## [9.12.0](https://github.com/ExaDev/agent-shim/compare/v9.11.0...v9.12.0) (2026-10-11)

### Features

* add a subagent and background-task walk to the rig's mock provider ([5f111e3](https://github.com/ExaDev/agent-shim/commit/5f111e309d49819911b3d7038efd027e5d3d13fe))
* list every quota window's reset in one view ([695a809](https://github.com/ExaDev/agent-shim/commit/695a809a6566217a8bea24b84afeae460ed4dec7))

### Bug Fixes

* run the mock provider's subagent walk once per prompt ([e80381e](https://github.com/ExaDev/agent-shim/commit/e80381e9cd235a68cf474ce45dba938d3082a79b))

### Documentation

* describe the agent and task events on the Remote Control read stream ([84f2c1f](https://github.com/ExaDev/agent-shim/commit/84f2c1fcd8aa3646b969a35125dbbbae87cfb3a8))

### Tests

* wait for the permission watcher to register instead of racing it ([b1e9bf2](https://github.com/ExaDev/agent-shim/commit/b1e9bf227ce0e1043fdb97f0a9a6cedc8375c142))

## [9.11.0](https://github.com/ExaDev/agent-shim/compare/v9.10.1...v9.11.0) (2026-10-11)

### Features

* rank pool members on the five-hour reset as well as the weekly one ([ef8148c](https://github.com/ExaDev/agent-shim/commit/ef8148cb890f5ccad9776d6eb91cd3b4531a0efe))

### Documentation

* describe the five-hour term in the pick report's score window ([144e27a](https://github.com/ExaDev/agent-shim/commit/144e27afede81fc95b8413ae5f747df0acbda17c))

## [9.10.1](https://github.com/ExaDev/agent-shim/compare/v9.10.0...v9.10.1) (2026-10-10)

### Bug Fixes

* end the MCP server when its client's input ends ([ecba06f](https://github.com/ExaDev/agent-shim/commit/ecba06fa73f4f6bb8033f1d63a390849fe5c5e9a))

## [9.10.0](https://github.com/ExaDev/agent-shim/compare/v9.9.0...v9.10.0) (2026-10-10)

### Features

* change the MCP server's permissions while it runs ([19d1580](https://github.com/ExaDev/agent-shim/commit/19d1580fd538bbf76436b58c7a45e1520485ce82))

### Documentation

* describe changing the MCP server's permissions at runtime ([8a664c7](https://github.com/ExaDev/agent-shim/commit/8a664c7265d48605ce26003e12a1b4a1519fb7e8))

## [9.9.0](https://github.com/ExaDev/agent-shim/compare/v9.8.0...v9.9.0) (2026-10-10)

### Features

* read a Codex home's account and rate limits through codex app-server ([65b6123](https://github.com/ExaDev/agent-shim/commit/65b612314de7ebb8870248af8e761b982efb17cf))

### Documentation

* describe the Codex account and rate-limit reader ([cece8a5](https://github.com/ExaDev/agent-shim/commit/cece8a5b8af9fe823a32a6e03b1ff0ea2db78f80))

## [9.8.0](https://github.com/ExaDev/agent-shim/compare/v9.7.2...v9.8.0) (2026-10-10)

### Features

* report whether an identity is signed in from account show and doctor ([a607b36](https://github.com/ExaDev/agent-shim/commit/a607b36dbbc15389bc1b95f8e463e764948aca7e))

### Documentation

* describe the sign-in state in account show and doctor ([2514883](https://github.com/ExaDev/agent-shim/commit/2514883c8563db7a0144634146381bf3fcdaa6f2))

## [9.7.2](https://github.com/ExaDev/agent-shim/compare/v9.7.1...v9.7.2) (2026-10-10)

### Bug Fixes

* report cascade diagnostics for a launch with no farm to resync ([954ddbc](https://github.com/ExaDev/agent-shim/commit/954ddbc1f01fb5a79678308f355ccacf228569f1))

## [9.7.1](https://github.com/ExaDev/agent-shim/compare/v9.7.0...v9.7.1) (2026-10-10)

### Bug Fixes

* expose launch.resolve to the read-only MCP tool set ([7cc484e](https://github.com/ExaDev/agent-shim/commit/7cc484eb0e0f278d8579f12642ee2b61483cde8b))

## [9.7.0](https://github.com/ExaDev/agent-shim/compare/v9.6.0...v9.7.0) (2026-10-10)

### Features

* add configuration-management procedures to the typed door API ([25f7046](https://github.com/ExaDev/agent-shim/commit/25f7046fa317adcb6ebab202f7ff06daa0bbf1b3))
* mount the configuration procedures on the door's whole typed API ([21497d4](https://github.com/ExaDev/agent-shim/commit/21497d4d47e2f8f1cb4c0c874144ba04d506bb40))
* require the credential block when a provider's base URL moves over the API ([bd80797](https://github.com/ExaDev/agent-shim/commit/bd8079770960b6cf5f2c15abb7a0b9e1d07765fc))

### Code Refactoring

* share the profile, rule-target, pool-member and credential-cache rules with the stores ([09febbb](https://github.com/ExaDev/agent-shim/commit/09febbb66443a3bea027f31be1f3af1d8315635f))

### Documentation

* describe the configuration procedures and export them from the library ([765422d](https://github.com/ExaDev/agent-shim/commit/765422de67b98f1151ffcb728f046c7dfc159699))

### Tests

* supply the configuration deps to the MCP end-to-end door ([db668f6](https://github.com/ExaDev/agent-shim/commit/db668f6edc5c5473a20b8119fa5c2973c403f8a9))

## [9.6.0](https://github.com/ExaDev/agent-shim/compare/v9.5.1...v9.6.0) (2026-10-10)

### Features

* resolve a launch over the door's typed API without performing it ([13eac1a](https://github.com/ExaDev/agent-shim/commit/13eac1ac22601863e659f48b9d5e0e6cacb0b3d6))
* serve the door's restart, update check and Codex sign-in on the typed API ([84f8450](https://github.com/ExaDev/agent-shim/commit/84f84505db47991bd760babeb3cebb613bd85a4a))
* serve the door's typed API to agents as MCP tools ([ddc2ca8](https://github.com/ExaDev/agent-shim/commit/ddc2ca818a0746a412bf049b2c35cb55bb511555))

### Bug Fixes

* report cascade diagnostics and tolerate an unresolved ambient credential ([afbc023](https://github.com/ExaDev/agent-shim/commit/afbc023d97e15bca1016d7604660c00d31902b30))

### Code Refactoring

* expose the update check, Codex logout and detached self spawn as functions ([e06cff6](https://github.com/ExaDev/agent-shim/commit/e06cff63c0204962d775671be7f222c7160dd451))
* split a launch's decisions from its effects ([9c2acb9](https://github.com/ExaDev/agent-shim/commit/9c2acb96a1791671cc54d1031cd6cbb4c8bfec56))

### Tests

* expect the mcp command among the top-level commands ([55ca824](https://github.com/ExaDev/agent-shim/commit/55ca824709ce63a1f96c4ad8da9e886eafaa9081))
* pin that a resolved launch changes and runs nothing ([3d52d6f](https://github.com/ExaDev/agent-shim/commit/3d52d6f16a7912f52bb7376c4c1940fd9839ae1b))
* supply the lifecycle, Codex and launch deps to the MCP end-to-end door ([9524ba0](https://github.com/ExaDev/agent-shim/commit/9524ba031a877fe58bb66733ea453eea58d12b78))

## [9.5.1](https://github.com/ExaDev/agent-shim/compare/v9.5.0...v9.5.1) (2026-10-10)

### Bug Fixes

* serve the OpenAPI document with each operation's Zod schemas on oRPC v2 ([c4600ce](https://github.com/ExaDev/agent-shim/commit/c4600ce59b60764f7d17a45a6cb3ae9f02d6a6dd))

## [9.5.0](https://github.com/ExaDev/agent-shim/compare/v9.4.3...v9.5.0) (2026-10-10)

### Features

* replace the serving front door in place, and do it on every automatic update ([28e391f](https://github.com/ExaDev/agent-shim/commit/28e391f3c3abc6f6354948e2595ea1e40f1f1c94))

### Tests

* expect the automatic update to spawn with the door restart ([8b97481](https://github.com/ExaDev/agent-shim/commit/8b97481e71b64b5474f3f527648cc8930c9a6623))

## [9.4.3](https://github.com/ExaDev/agent-shim/compare/v9.4.2...v9.4.3) (2026-10-10)

### Bug Fixes

* wait for a fresh bearer once the read stream refuses the observed one ([c391532](https://github.com/ExaDev/agent-shim/commit/c391532f4abb76d29480265b640ae04d28122897))

### Tests

* derive the refreshed bearer from the create bearer ([3ad2bcf](https://github.com/ExaDev/agent-shim/commit/3ad2bcf54b685a434f9e32833f768d7d1f2d0b39))

## [9.4.2](https://github.com/ExaDev/agent-shim/compare/v9.4.1...v9.4.2) (2026-10-10)

### Bug Fixes

* keep the door's source-port range constants module-private ([1614121](https://github.com/ExaDev/agent-shim/commit/1614121dfd05702f3535f8abeb2a03456f7a5c35))
* pool the door's upstream connections and widen its reserved source-port range ([f155194](https://github.com/ExaDev/agent-shim/commit/f1551943e482bd216f2ca0d19a78e671b40327da))

## [9.4.1](https://github.com/ExaDev/agent-shim/compare/v9.4.0...v9.4.1) (2026-10-10)

### Bug Fixes

* replay a headroom hop the daemon resets before any response byte ([39f5877](https://github.com/ExaDev/agent-shim/commit/39f58772884baea1007f1a365590eaa974de956f))

### Continuous Integration

* stop stamping a static platform block on every release ([a9a4b82](https://github.com/ExaDev/agent-shim/commit/a9a4b825ececefd02f21ec9fd79338b417ebfd9c))

## [9.4.0](https://github.com/ExaDev/agent-shim/compare/v9.3.2...v9.4.0) (2026-10-10)

### Features

* show which window a pool member's score is divided by in pool pick ([96a94b4](https://github.com/ExaDev/agent-shim/commit/96a94b4ddc13dbaa162a43238959b2a8b232e3d7))

## [9.3.2](https://github.com/ExaDev/agent-shim/compare/v9.3.1...v9.3.2) (2026-10-10)

### Documentation

* say which window a pool member's score is divided by ([67eb10f](https://github.com/ExaDev/agent-shim/commit/67eb10fb51932c4b6d138afccf3a61a3800b5c5b))

## [9.3.1](https://github.com/ExaDev/agent-shim/compare/v9.3.0...v9.3.1) (2026-10-09)

### Documentation

* say what a running front door re-reads and what needs a restart ([774c685](https://github.com/ExaDev/agent-shim/commit/774c685a95cff6d3eca26489cde8759fe855803b))

## [9.3.0](https://github.com/ExaDev/agent-shim/compare/v9.2.1...v9.3.0) (2026-10-09)

### Features

* record the usage endpoint's extra-usage spend and the remaining rate-limit headers ([d91c22c](https://github.com/ExaDev/agent-shim/commit/d91c22ca85bd6f3ba76fd051cfd1764f67e31bdf))

## [9.2.1](https://github.com/ExaDev/agent-shim/compare/v9.2.0...v9.2.1) (2026-10-09)

### Bug Fixes

* class a seat whose own rate-limit tier is zero as pay-per-use ([da67a89](https://github.com/ExaDev/agent-shim/commit/da67a89ada1c97c9fb8e5f45f506b3272e2b53f7))

## [9.2.0](https://github.com/ExaDev/agent-shim/compare/v9.1.0...v9.2.0) (2026-10-09)

### Features

* let pool and routing conditions read the extra-usage allowance ([693af88](https://github.com/ExaDev/agent-shim/commit/693af88ebd96c57fa9918f1609e106b06ff2549f))
* read, show and rank on the extra-usage meter of an account with no plan windows ([6650dd7](https://github.com/ExaDev/agent-shim/commit/6650dd7da72b409e2a4bd9b86114551b5d190950))

### Bug Fixes

* stop probing the usage endpoint for an account metered only by extra usage ([920ddb5](https://github.com/ExaDev/agent-shim/commit/920ddb53545e3b9fedba152e1c5b662aa71ca279))

## [9.1.0](https://github.com/ExaDev/agent-shim/compare/v9.0.0...v9.1.0) (2026-10-08)

### Features

* export PoolGraphError so an embedder can catch what poolIdentities throws ([e35571a](https://github.com/ExaDev/agent-shim/commit/e35571af67f296aef4b41c91b697eecce6072c6a)), closes [#304](https://github.com/ExaDev/agent-shim/issues/304)

## [9.0.0](https://github.com/ExaDev/agent-shim/compare/v8.44.0...v9.0.0) (2026-10-08)

### ⚠ BREAKING CHANGES

* keep headroom state in one unversioned file, migrated in place

### Features

* keep headroom state in one unversioned file, migrated in place ([bc62a34](https://github.com/ExaDev/agent-shim/commit/bc62a34c7851bb0ae94e50ab9d89083d4a46185a))

### Bug Fixes

* pin the doctor's legacy resolution and tidy the state doc comments ([2e0d39c](https://github.com/ExaDev/agent-shim/commit/2e0d39c98f8a3ce004e63c1c7958d9897946ca99))
* report the TCP-port era's state as claimable and cover the legacy wiring ([19308b6](https://github.com/ExaDev/agent-shim/commit/19308b675296b6a16a2473b396b4b3f51d4ecad1))

### Tests

* make a swapped state pair observable and tidy the last notes ([ac8dfb8](https://github.com/ExaDev/agent-shim/commit/ac8dfb8cbec187f0f63b09fc33db0a7ad8139ddc))

## [8.44.0](https://github.com/ExaDev/agent-shim/compare/v8.43.0...v8.44.0) (2026-10-08)

### Features

* turn the front door over when the installed binary changes ([f4c0af7](https://github.com/ExaDev/agent-shim/commit/f4c0af726f2c47c5c1b9dbc371ff0306cc1fc14e))

### Bug Fixes

* prefer the agent-shim sibling only when it exists ([08484d4](https://github.com/ExaDev/agent-shim/commit/08484d4be0318a4aac4beb09512f9e6414ee5058))
* watch the installed agent-shim entry, not the door's own exec'd path ([414851a](https://github.com/ExaDev/agent-shim/commit/414851a756770f38122d1bd71b8da15009815f17))

### Documentation

* correct the idle-only layouts and the no-sibling fallback wording ([d3e6cb3](https://github.com/ExaDev/agent-shim/commit/d3e6cb3c219a93478a1c0ace5ec785bdd17721f0))
* scope the idle-only reason to the entry the update ran through ([1f2074c](https://github.com/ExaDev/agent-shim/commit/1f2074cd5bf3fd67c968b90b86a9e84edb18f6c8))

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
