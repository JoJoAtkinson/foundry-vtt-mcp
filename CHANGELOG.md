## Unreleased (fix/optional-2026-10-11)

Fixes from the 2026-10-11 live checks. Deploy both halves (server and bridge module).

### Behaviour

- `toggle-token-condition` with `active` omitted toggles the current state, as its schema always said; before, the bridge module refused it with `active must be a boolean`. Resolved in the fork's bridge-query wrapper (`src/fork/toggle-condition.ts`); no upstream file changes
- `toggle-token-condition` with `active` omitted decides "already has it" exactly as upstream's removal does (raw `conditionId` in the effect's statuses, or its name/label, case-insensitive). A condition named so it matches only through the resolved status id (e.g. `Prone` on an effect named something else) is now applied, not sent to a removal that removed nothing (fork-edge-4)
- `dnd5e-add-feature` with `recharge`: when the GM tab does not answer the recharge query within 10 s, the result's `recharge` note is now `unknown (the GM tab did not answer in 10 s; it may have applied — re-read the feature before retrying)` instead of `not applied (… Query timeout …)`, since a timeout does not mean the row was not written. Every other failure is still `not applied (<why>)` (fork-ac-3)
- `pentaryn-write` whose write landed but whose result holds an invalid Date (or anything else that will not serialize) answers `ok: true` instead of throwing `INTERNAL: … Invalid time value`, so the action log records it as landed: an invalid Date comes back as `'[unserializable]'`, and a result that still cannot be serialized is `{ok: true, result: '[unserializable]', reason: 'result could not be serialized'}` (rob-1)
- `eval-js` whose result holds an invalid Date (top level, in an array, a Map/Set/Collection or an object) returns `'[unserializable]'` in its place instead of failing the whole eval with `RangeError: Invalid time value`. Bridge module change (`src/fork/serialize.ts`); the eval-js description is unchanged (rob-2)
- The bridge module's eval query given a `timeoutMs` that is not a finite number (a non-numeric string, `NaN`, `Infinity`, an object) now waits the default 10 s instead of timing out at once (`NaN` reached `setTimeout` as 0; `Infinity` clamped to 60 s). A numeric string is used as its number; `null`/omitted is still 10 s. The server's `eval-js` schema already rejected these, so this guards callers that reach the bridge query directly. Bridge module change (`src/fork/handlers.ts`) (rob-3)
- `toggle-token-condition` given an `active` that is not a boolean (`"true"`, `null`, `1`, …) is now refused with upstream's `active must be a boolean` instead of being silently replaced by a toggle of the current state. Only an omitted `active` toggles. The server's schema already rejected these, so this guards callers that reach the bridge query directly. Bridge module change (`src/fork/toggle-condition.ts`) (rob-4)
- `pentaryn-read` / `pentaryn-write` on a namespace whose `describe()` has a `null` (or other non-object) row in `methods`: an unknown path is now `NOT_FOUND` with the path listing instead of `INTERNAL: Cannot read properties of null`; such rows are skipped and never match. Server change (the call template in `src/fork/tools/pentaryn-call.ts`) (rob-5)
- A session whose `tools/list_changed` notify fails (the send rejects) is now told on the next 30 s tick: the new list counts as served only once the send resolves, and the failure is logged as `tools/list changed but notify failed: <why>; will retry`. Before, the list was marked served first and the error swallowed, so that session never learned of the rebuilt backend's tools. A failed backend poll is still silent. Server change (`src/fork/tool-list-watch.ts`) (rob-6)
- The `tools/list_changed` poll skips a 30 s tick while the previous poll (backend fetch and notify) is still in flight, so a slow notify can no longer let two polls send the same change twice. Server change (`src/fork/tool-list-watch.ts`) (fork-edge-7)
- `prompt-markers` errors now carry a `code` property like every other pentaryn error: `MODULE_MISSING` and `TIMEOUT` are built with `codedError()`, and a module refusal passed through as `CODE: detail` (`TEXT_CHANGED`, `BAD_SPEC`, …) has its leading code set as `code`. An uncoded message has none. Message text is byte-for-byte unchanged. Server change (`src/fork/tools/prompt-markers.ts`) (rob-7)
- `dnd5e-add-feature` with `recharge` keeps an activity's item-uses consumption target that names another item (e.g. ammunition or a shared pool); only the feature's own item-uses target (blank or its own id) is replaced by the Recharge one. Before, every item-uses target was dropped. Bridge module change (`src/fork/recharge.ts`) (fork-edge-5)
- `pentaryn-read` `{ns: "*", path: "describe"}` given a `ref` or non-empty `opts` is refused with `BAD_ARGS` (`game.pentaryn.describe takes no ref or opts`) instead of silently ignoring them, as the call template's header promised. The root `inspect` still takes both (fork-edge-6)

### Action log

- `pentaryn-write` lines carry the ids of the documents the module returned when its result has no `ids` of its own (`{uuid}`, `{_id}`, a Foundry-shaped `{id}`, `documents`, arrays; depth ≤ 4, ≤ 50 ids; never throws). `dropbin.restoreResult` logs the created item and its actor instead of `ids: []`. A dry run or a refusal logs `ids: []`
- An upstream write tool that refuses as a value (`{success: false, error}` — `switch-scene`, `assign-actor-ownership`/`remove-actor-ownership`, `wfrp4e-*`, map jobs) is logged `ok: false` with that `error`, not `ok: true` (fork-edge-2)
- Every upstream tool the server serves must be classified as a write (logged) or a read (`UPSTREAM_READ_TOOLS` beside the write globs in `src/fork/upstream-writes.ts`); `fork/upstream-writes.test.ts` builds the real upstream tool classes and fails naming any tool an upstream rebase adds unclassified. No runtime change (ext-6)
- An `eval-js` call rejected for its own arguments: the action-log line in `mcp-<YYYY-MM>.jsonl` now has `phase: "args"` and the same one-line error as the eval line (`script: …; timeoutMs: …`), not the multi-line validation dump. The thrown error is unchanged. Any fork handler can attach `phase` / `logError` to what it throws

---

## v0.8.3-pentaryn.2 (2026-10-11)

Fork release (branch `pentaryn`, wave 2 of the pentaryn blueprint migration). Needs **both**
halves deployed together: the server (`npm run build:server`, restart the backend) and the
bridge module (`npm run build:foundry`, copy into `Data/modules/foundry-mcp-bridge`, reload
the GM tab) — `dnd5e-add-feature`'s recharge needs the new module query.

### New tools (D14)

- `pentaryn-read` `{ns, path, ref?, opts?, timeoutMs?}` — a read method of a Pentaryn blueprint module (`game.pentaryn.<ns>.<path>`); `{ns:"*", path:"describe"}` is the discovery call. Write rows are refused (`BAD_ARGS: use pentaryn-write`), unknown ns/path answer `NOT_FOUND` listing what exists, module refusals (`NOT_FOUND`, `AMBIGUOUS`, …) are values. Logged compactly: `{ts, tool, ns, path, ref, ok, code?, ms, client?}` — no arguments, no result
- `pentaryn-write` `{… , dryRun?}` — a write method, as the GM; read rows are refused (`BAD_ARGS: use pentaryn-read`); logged in full (args, ok, code, summary, ids)
- Both run one fixed script template through the existing `fork.eval` query and route on `describe()` read in the GM tab on every call; `ref` is resolved by the module, never a substring. Positional parameters other than `ref`/`opts` are passed by name inside `opts`

### Action log

- Upstream write tools (`create-*`, `update-*`, `delete-*`, `manage-*`, `dnd5e-*`, `move-token`, …) are logged to `mcp-<YYYY-MM>.jsonl` too, not only fork tools
- Every action and eval line carries `client: {pid, ppid}` of the calling wrapper (one per Claude session)
- The month in `mcp-<YYYY-MM>.jsonl` is taken when the line is written, not when the backend started
- The eval log rotates monthly: `eval-<YYYY-MM>.jsonl` (the old `eval.jsonl` is left in place; read `eval*.jsonl`)
- A tool that answers `{ok:false}` is logged `ok:false` with its `phase`/`code`; `eval-js`'s action-log line keeps `{purpose, scriptChars, timeoutMs}` instead of the whole script (the script stays in the eval log)
- An `eval-js` call rejected for bad arguments leaves a `phase:"args"` eval line; a browser-side timeout is marked `timedOut: true`
- `prompt-markers replace` with `specFile` logs the file's replacements, not only its path

### Behaviour

- `FOUNDRY_MCP_TOOL_FILTER` now refuses calls to a filtered tool (upstream ones too), not only hides it
- `tools/list_changed` fires on a changed `inputSchema` or a same-length description edit (the key is a sha1 of name, description and schema)
- `dnd5e-add-feature` `recharge`: applied through the GM-guarded `foundry-mcp-bridge.fork.applyRecharge` query with upstream's actor resolution, so a scene **token id** works; the item is found by id; the outcome is logged
- Security: upstream `foundry-mcp-bridge.*` queries refuse a `User#query` from a non-GM sender (they checked only the running client); calls with no sender (the bridge socket, a module calling the handler directly) are unchanged. Fork guard errors are coded `NOT_GM: Access denied: …`
- Eval: the timeout timer is cleared when a script finishes; a timeout says `timedOut: true` and that the script may still be running
- `eval-js`'s description states the serializer rules (depth ≤4, arrays ≤200, collections ≤100, …) and points at `game.pentaryn.describe()` and the D14 tools

### Internal

- `src/fork/action-log.ts` (one writer for both logs), `tool-list-watch.ts` (the wrapper's poll, out of `index.ts`), `upstream-writes.ts`, `recharge.ts` (both packages), `serialize.ts` + `SERIALIZE_LIMITS` (module), `legacy-keys.ts` (one module-scope Set), `prompt-markers.schema.ts` (the zod block, with one `SIZES`, `InlineItem`, `Disposition`); typed tool contract (`WriteFlag`, `ForkToolResult`, `ForkCallMeta`, `logArgs`)
- `packages/foundry-module` has a vitest harness: `npm -w @foundry-mcp/module test -- --run`

---

## v0.8.3-pentaryn.1 (2026-10-10)

Fork release (branch `pentaryn`) porting the D&D 5e paths to dnd5e 6.0.6.

### dnd5e 6.x

- `get-character` (dnd5e adapter) now returns `stats.movement` — `{ speeds, units, hover? }` read from `attributes.movement.speeds` (6.0), falling back to the flat pre-6 keys
- Sanitized actor/item data no longer repeats speeds: when a movement object carries `speeds`, the enumerable legacy shim keys (`walk`, `burrow`, `climb`, `fly`, `jump`, `swim`) are skipped, as the 5.3 senses keys already were
- Sanitized data keeps `Set` fields as arrays (item properties, damage types, and 6.0's `rarities`); they used to flatten to `{}`
- `search-compendium` requests `system.rarities` / `system.rarity` in the pack index and puts the rarity word in each item result's summary, for any physical item type (multiple rarities join as `rare/veryRare`); `get-compendium-item` reports `properties.rarity` from `rarities`
- Compendium creature speed summaries read `attributes.movement.speeds`
- `dnd5e-create-npc` still writes the legacy `movement.*` / `senses.*` keys on purpose: dnd5e migrates them to `speeds` / `ranges` on create

### prompt-markers, transport timeout, image passthrough (fork)

- New fork tool `prompt-markers` (`action`: `list | gather | crops | replace | show`) fronting the pentaryn `pentaryn-prompts` module's `CONFIG.queries`; `npc` replacements were first composed server-side through the `dnd5e-create-npc` / `dnd5e-add-feature` engines — since pentaryn-prompts 0.3.0 the module builds them itself (through the same bridge handlers) and the tool prints the module's readback; only `replace` is action-logged
- `FoundryConnector.query(method, data, { timeoutMs })` — per-query transport timeout (default 10 s, clamped 1-120 s); `eval-js` now waits its own `timeoutMs` + 2 s instead of being cut at 10 s
- Fork tools may return `{ __mcpContent: [...] }` to pass MCP content blocks (images) through the backend (`fork/content.ts`)
- Fork registry `write` may be a predicate over the call's arguments
- Security: `foundry-mcp-bridge.fork.eval` rejects a `User#query` from a non-GM (`ctx.user`), not only a non-GM running client — players hold `QUERY_USER` by default

### prompt-markers eval round 1 (fork)

- `prompt-markers replace`: `with.kind: "character"` (level-N PC from the PHB, advanced by the module), `actor` + `patch` (stock monster plus changes), `npc` + `patch` and per-feature `recharge`, inline `{data}` / by-name hotspot items, replacement-level `ring` / `img` / `disposition`, `party` on gather and replace; the readback prints `markerDeleted=true|false`, character sheets, `DEFAULTED` choices, patches and per-encounter XP vs the party budget
- `dnd5e-add-feature`: `recharge` (2-6) sets Recharge n-6 on the created feature (applied through the GM-guarded fork eval query)
- Wrapper (`index.ts`): declares `tools.listChanged` and notifies the client when the backend's tool list changes (polled every 30 s), so a rebuilt backend's new tools reach sessions that started earlier

### Fixes

- `request-player-rolls`: a `save` roll used the ability's `save` object (formula `1d20+[object Object]`); it now uses `save.value`
- `request-player-rolls`: `initiative` used `init.mod` (the ability modifier only); it now uses `init.total`

---

## v0.8.3 (2026-06-11)

### New Features

- **Mongoose Traveller 2e (mgt2e) System Support**
  - `list-creatures-by-criteria` now works on mgt2e worlds: filters by hit points, psionics, creature type, and actor type; indexed metadata includes characteristic DMs (STR/DEX/etc.)
  - `search-compendium` extracts mgt2e-relevant stats (hits, behaviour, species, tonnage) from search results
  - `manage-world-items` gains a new `describe` action that returns a live enum reference for mgt2e item fields (weapon traits, scales, armour forms, hardware system discriminators, software classes, etc.) — call it before creating items to get valid keys

- **`manage-actors` — generic actor CRUD tool** (works on any game system)
  - `create`: create one or more actors of any type with arbitrary `system` data; mgt2e convenience: accepts skill shorthands (`{ pilot: 2 }`), lowercase characteristic keys, and `system.details` remapped to `system.sophont`
  - `update`: patch existing actors by ID; mgt2e skill shorthands normalised server-side (avoids Electron module-cache issue that prevented browser-side normalisation)
  - `delete`: delete actors by ID
  - `update-items`: update embedded items on an actor by item ID
  - `delete-items`: delete embedded items from an actor by item ID

### Fixes

- `getIndex()` now uses the return value rather than `pack.indexed` state, fixing compendium indexing on Foundry v13 where `pack.indexed` behaviour changed

---

## v0.8.2 (2026-06-07)

### New Features

- **D&D 5e NPC Creation Suite** (PR #41 by @LManfre)
  - `dnd5e-create-npc` — build a full NPC stat block from scratch (abilities, saves, skills, senses, AC/HP, CR)
  - `dnd5e-add-feature` — one tool with modes: `passive`, `save`, `attack`, `attack-with-save`, `aura`, `spellcasting`, `spells`
  - `dnd5e-add-features-from-compendium` — bulk-import features/spells from compendium packs
  - Targets the dnd5e activities data model (4.x/5.x)

- **WFRP4e (Warhammer Fantasy Roleplay 4e) System Support** (PR #53 by @nyoung)
  - Character extraction: 10 characteristics, wounds, fate/fortune, resilience/resolve, corruption, career/species/class, skills, and arcane/divine spellcasting
  - `get-character` / `list-characters` / `search-character-items` now work on WFRP4e worlds

### Fixes

- **macOS installer** (PR #54): the Claude Desktop config is now merged rather than overwritten, preserving any other configured MCP servers; more robust logged-in-user detection; postinstall scripts no longer abort on a non-critical failure; additional Foundry data-dir locations probed
- **Node 26 install failure** (Issue #51, reported by @frankyh75): removed the unused `better-sqlite3` dependency, which failed to build against Node 26's V8 ABI

---

## v0.6.2 (2025-12-03)

### New Features

- **Spellcasting Data Extraction** (Issue #14)
  - `get-character` now returns full spellcasting entries with spell lists
  - PF2e: Spellcasting entries with traditions, DC, attack, slots, prepared/expended status
  - D&D 5e: Class-based spellcasting with spell slots and prepared spells
  - DSA5: Zauber (spells), Liturgien, Zeremonien, Rituale with AsP/KaP tracking
  - **Spell Targeting Info**: Each spell now includes `range`, `target`, and `area` fields
    - D&D 5e: Range (Self/Touch/60 ft), target type (1 creature/self/area), area template
    - PF2e: Range, descriptive target, area type (emanation/cone/burst)
    - DSA5: Reichweite, Zielkategorie, Wirkungsbereich

- **Use Item Tool** (`use-item`)
  - Cast spells, use abilities, activate features, consume items
  - Works across systems: D&D 5e, PF2e, DSA5
  - Supports spell upcasting (D&D 5e)
  - Proper resource consumption (spell slots, charges, consumables)
  - GM-only with character targeting
  - **Target Selection**: Specify targets by name or use `["self"]` to target caster
    - Example: "Have Clark cast Magic Missile on the Goblin"
    - Example: "Have Vitch use a healing potion on himself"
    - Targets set via Foundry's targeting system before item use

- **Search Character Items Tool** (`search-character-items`)
  - Token-efficient item search within a character's inventory
  - Filter by type (weapon, spell, feat, equipment, etc.)
  - Filter by category (items, spells, features, all)
  - Text search across item names and descriptions
  - Returns compact results without full descriptions

---

## v0.6.1 (2025-12-03)

### New Features

- **DSA5 System Support** (PR #12 by @frankyh75)
  - Full SystemAdapter implementation for Das Schwarze Auge 5
  - Supports all 8 Eigenschaften (MU/KL/IN/CH/FF/GE/KO/KK)
  - LeP, AsP, KaP resource tracking
  - DSA5-specific filters: level, species, culture, size, hasSpells
  - DSA5IndexBuilder for creature compendium indexing
  - DSA5 character creation from archetypes

- **Token Manipulation Tools** (PR #13)
  - `move-token` - Move tokens with optional animation
  - `update-token` - Update visibility, disposition, size, rotation, elevation
  - `delete-tokens` - Bulk token deletion
  - `get-token-details` - Detailed token info with linked actor data
  - `toggle-token-condition` - Apply/remove status effects (prone, poisoned, etc.)
  - `get-available-conditions` - List system-specific status effects

- **Character API Optimization** (PR #9)
  - Lazy-loading: `get-character` now returns minimal item metadata (no descriptions)
  - New `get-character-entity` tool for on-demand full entity details
  - Removed 20-item limit - now returns ALL items
  - ~37% token reduction per character
  - PF2e: traits, rarity, level, actionType
  - D&D 5e: attunement status

### Improvements

- **Documentation** (PR #8)
  - Clarified search-compendium limitations (name-only search, heuristic filters)
  - Directed users to list-creatures-by-criteria for accurate filtering

---

## v0.4.17 (2025-09-09)

- Wrapper/backend architecture: convert MCP entry to a thin stdio wrapper that proxies to a singleton backend over `127.0.0.1:31414`.
- Backend singleton + lock: backend binds Foundry connector on `31415` and creates `%TEMP%\foundry-mcp-backend.lock`.
- Startup race fix: resolves Claude Desktop duplicate-start race by keeping wrappers alive and ensuring only one backend owns ports.
- Runtime stability: backend now bundled (`dist/backend.bundle.cjs`) and preferred by wrapper for reliable startup in installer environments.
- Shared package now emits JS + d.ts, ensuring runtime availability for both dev and installer.
- Logging: wrapper writes to `%TEMP%\foundry-mcp-server\wrapper.log`; backend logs to `%TEMP%\foundry-mcp-server\mcp-server.log`.
- Installer: enhanced staging to include full server `dist`, bundled wrapper `index.cjs`, bundled backend, and `node_modules/@foundry-mcp/shared`.
- Build scripts: added root convenience scripts (`build:release`, `bundle:server`, `installer:stage`); NSIS script accepts `--skip-download` and `--skip-nsis` for staging-only runs.

Notes

- No changes needed for CI; existing workflows continue to build bundles and the installer.
- Foundry MCP Bridge port remains `31415`. Control channel is `31414` (internal wrapper↔backend only).
