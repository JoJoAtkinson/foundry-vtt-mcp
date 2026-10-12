/**
 * prompt-markers — the one-call context export and the replace helper for the
 * `pentaryn-prompts` Foundry module (design: pentaryn repo,
 * context/plans/prompt-markers.md; playbook: context/foundry/prompt-markers.md).
 *
 * All geometry, LOS, grouping, text rendering, placement, provenance, npc building and the
 * replace readback live in the module, behind GM-guarded `CONFIG.queries` handlers. This file only:
 *   - validates arguments per action (zod; the module re-checks every field and names the bad one),
 *   - gives each query a realistic transport timeout (gather with crops is ~8 s),
 *   - turns crops into MCP image blocks (plus files under the OS temp dir),
 *   - holds the "dry run before a batch over 5" gate (identical spec, this backend's lifetime),
 *   - prints the module's replace readback (`text`) as it is, so the eval-js fallback
 *     (`game.pentaryn.prompts.replaceMany(...).text`) reads back exactly the same lines,
 *   - logs `replace` (and only `replace`) to the fork action log.
 *
 * Since module 0.3.0 `with.kind: "npc"` ({npc, features, patch}) is built by the module itself,
 * through the same foundry-mcp-bridge handlers dnd5e-create-npc and dnd5e-add-feature call, so it
 * works on the eval-js path too. This file passes it through untouched.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import type { FoundryClient } from '../../foundry-client.js';
import type { Logger } from '../../logger.js';
import type { McpContentBlock } from '../content.js';
import type { ForkRegistry } from '../registry.js';
import { codedError } from './pentaryn-call.js';
import { ACTIONS, parseArgs, type Action, type ReplacementT } from './prompt-markers.schema.js';

export { parseArgs, type ReplacementT };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TOOL_NAME = 'prompt-markers';

export const QUERIES = {
  list: 'pentaryn-prompts.list',
  gather: 'pentaryn-prompts.gather',
  crops: 'pentaryn-prompts.crops',
  replace: 'pentaryn-prompts.replace',
  show: 'pentaryn-prompts.show',
} as const;

/** Transport timeouts (ms). The connector default is 10 s; gather with 6 crops is ~8 s. */
export const TIMEOUTS = {
  list: 15_000,
  gather: 60_000,
  crops: 60_000,
  replace: 60_000,
  show: 15_000,
} as const;

/** The playbook rule "dry run before any batch over 5", enforced. */
export const DRY_RUN_THRESHOLD = 5;

/** ~20k tokens of text — past this, one gather per scene is the better call. */
const LONG_TEXT_CHARS = 80_000;

/**
 * `{action: "replace", specFile}` → the same call with the file's replacements (and its call/party
 * unless the call gives them). The file is JSON: an array of replacements or {call?, party?,
 * replacements}. dryRun/force/skipDryRun are never read from it — the call decides how it runs.
 */
export function withSpecFile(
  raw: any,
  read: (p: string) => string = p => readFileSync(p, 'utf8')
): any {
  if (!raw || raw.action !== 'replace' || typeof raw.specFile !== 'string') return raw;
  const path = raw.specFile.trim();
  if (!isAbsolute(path))
    throw new Error(`BAD_SPEC: specFile must be an absolute path; got ${path}`);
  let body: string;
  try {
    body = read(path);
  } catch (err: any) {
    throw new Error(
      `BAD_SPEC: specFile ${path}: cannot read (${err?.code ?? err?.message ?? err})`
    );
  }
  let spec: any;
  try {
    spec = JSON.parse(body);
  } catch (err: any) {
    throw new Error(
      `BAD_SPEC: specFile ${path}: not JSON (${String(err?.message ?? err).slice(0, 120)}) — write JSON, not a JS object literal`
    );
  }
  const file = Array.isArray(spec) ? { replacements: spec } : (spec ?? {});
  if (!Array.isArray(file.replacements)) {
    throw new Error(`BAD_SPEC: specFile ${path}: needs "replacements" (or be an array of them)`);
  }
  const { specFile: _drop, ...rest } = raw;
  void _drop;
  return {
    ...rest,
    replacements: rest.replacements ?? file.replacements,
    ...((rest.call ?? file.call) ? { call: rest.call ?? file.call } : {}),
    ...((rest.party ?? file.party) ? { party: rest.party ?? file.party } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool definition (flat JSON schema; per-action validation is zod's job)
// ---------------------------------------------------------------------------

const DEFINITION = {
  name: TOOL_NAME,
  description:
    'Prompt markers (pentaryn-prompts module): hidden marker tokens Joe dropped on maps with a ' +
    'typed prompt. Playbook: context/foundry/prompt-markers.md — read it before replacing.\n' +
    '• list — scenes with prompt counts.\n' +
    '• gather — THE one call: every prompt with distances, bands, bearings, LOS, encounters, ' +
    'loners and already-built things with provenance, as tagged text (+ map crops as images). ' +
    'Ids p#/t#/E# and the `call` id are what replace uses.\n' +
    '• crops — {call, encounters:["E1"]}: (re)render crops after a gather.\n' +
    '• replace — {call, replacements:[{id:"p3", with:{kind,...}, name?, hidden?, note?, ring?, img?, ' +
    'disposition?}], dryRun?, force?, party?}. kind: actor(uuid|actorId, patch?: stock monster plus ' +
    'changes, incl. creatureType and languages) | npc(npc: dnd5e-create-npc args, features: ' +
    'dnd5e-add-feature args without actorIdentifier, + recharge; built by the module) | ' +
    'character(level-N PC from the PHB: class, subclass, species, background, abilities, choices; ' +
    'dnd5e advancements run for you; startingEquipment:"A" for the PHB gear) | hotspot (light? for a glow) | ' +
    'note (light?) | light | tile | none. The dry run checks every key, item, spell and choice the real ' +
    'run would, lists ALL problems of a replacement at once, and builds characters on an unsaved actor so ' +
    'their DEFAULTED/WARN lines and sheet show before anything exists. specFile: a local JSON file ' +
    '(array of replacements or {call, party, replacements}) instead of an inline spec. ' +
    `Places on the marker footprint, stamps provenance, deletes the marker, reads back. Over ` +
    `${DRY_RUN_THRESHOLD} replacements needs the identical call with dryRun:true first.\n` +
    '• show — {call, id}: pan the GM canvas to a marker.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      scenes: {
        description:
          'gather: "all" (default: every scene with a prompt), "current", or scene ids/names.',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      crops: {
        description:
          'gather: "auto" (default; on for a single-scene gather), true, or false. Max 6, one per encounter.',
        anyOf: [{ type: 'string', enum: ['auto'] }, { type: 'boolean' }],
      },
      chars: {
        type: 'number',
        description: 'gather: description preview length, cut at a sentence (default 400).',
      },
      party: {
        description:
          'gather/replace: party for 2024 DMG encounter budgets — "4x5" (size x level), ' +
          "{size, level}, or a list of levels. Default: the module's world setting.",
        anyOf: [
          { type: 'string' },
          { type: 'object' },
          { type: 'array', items: { type: 'number' } },
        ],
      },
      unseenWithinFt: {
        type: 'number',
        description: 'gather: list door/wall-blocked neighbours within this many ft (default 60).',
      },
      builtWithoutProvenance: {
        type: 'boolean',
        description: 'gather: include hand-built tokens as context (default true).',
      },
      maxPrompts: {
        type: 'number',
        description: 'gather: page size (default 60); `next` names the first scene left out.',
      },
      call: { type: 'string', description: 'The gather call id, e.g. "pm-7f3a".' },
      encounters: {
        type: 'array',
        items: { type: 'string' },
        description: 'crops: encounter ids, e.g. ["E1"].',
      },
      id: { type: 'string', description: 'show: a prompt id, e.g. "p3".' },
      sceneId: {
        type: 'string',
        description: 'show: scene id (with markerId) instead of call+id.',
      },
      markerId: { type: 'string', description: 'show: marker token id.' },
      replacements: {
        type: 'array',
        description:
          'replace: [{id:"p3" | sceneId+markerId, with:{kind:...}, name?, hidden?, note?, ring?, img?, disposition?}].',
        items: { type: 'object' },
      },
      specFile: {
        type: 'string',
        description:
          'replace: absolute path of a JSON file holding the replacements (an array, or {call, party, ' +
          'replacements}) — write the spec there once instead of pasting it into every call. ' +
          'dryRun/force always come from the call.',
      },
      dryRun: { type: 'boolean', description: 'replace: return the plan, write nothing.' },
      force: {
        type: 'boolean',
        description: 'replace: override TEXT_CHANGED only (Joe edited the prompt after gather).',
      },
    },
    required: ['action'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Surface the module's `CODE: detail` instead of the client's wrapper text, and
 * name the two transport failures that otherwise read as mysteries. Every coded
 * error carries `code` (codedError's shape); an uncoded message has none.
 */
export function friendlyError(err: unknown, method: string): Error {
  let msg = String((err as any)?.message ?? err);
  msg = msg.replace(/^Query \S+ failed: /, '');
  if (/No handler found for query: pentaryn-prompts\./.test(msg)) {
    return codedError(
      'MODULE_MISSING',
      `pentaryn-prompts is not active in the GM client (no ${method} handler). ` +
        'Install with `make foundry-prompts-sync`, restart the world on first install, reload the GM tab.'
    );
  }
  if (/^Query timeout: /.test(msg)) {
    return codedError(
      'TIMEOUT',
      `${method} did not answer in time (${msg}). Gather one scene at a time, ` +
        'pass crops:false, or check the GM tab is open and not throttled in the background.'
    );
  }
  const coded = /^([A-Z][A-Z0-9_]*): /.exec(msg);
  return coded ? Object.assign(new Error(msg), { code: coded[1] }) : new Error(msg);
}

/** Split a base64 payload or data URL into MCP image fields. */
export function toImage(png: string, mimeType?: string): { data: string; mimeType: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(png);
  if (m) return { data: m[2], mimeType: mimeType ?? m[1] };
  return { data: png, mimeType: mimeType ?? 'image/webp' };
}

const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

function safeSegment(s: string): string {
  return (
    String(s)
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 64) || 'x'
  );
}

/** Hash of a replace spec, ignoring dryRun — what a dry run "pre-approves". */
export function specKey(
  call: string | undefined,
  replacements: unknown[],
  force?: boolean
): string {
  return createHash('sha256')
    .update(JSON.stringify({ call: call ?? null, replacements, force: !!force }))
    .digest('hex')
    .slice(0, 16);
}

/** Copy of `o` without `keys` (destructuring would leave unused bindings behind). */
function omit<T extends Record<string, any>>(o: T, ...keys: string[]): Record<string, any> {
  const out: Record<string, any> = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

function fmtCounts(c: any): string {
  if (!c || typeof c !== 'object') return '';
  return ['scenes', 'prompts', 'built', 'encounters', 'alone']
    .filter(k => c[k] !== undefined)
    .map(k => `${k}=${c[k]}`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface PromptMarkerDeps {
  foundryClient: Pick<FoundryClient, 'query'>;
  logger: Logger;
  /** Directory crops are also written to. Default: os.tmpdir()/pentaryn-prompts */
  cropDir?: string;
}

export function createPromptMarkersHandler(deps: PromptMarkerDeps) {
  const { foundryClient } = deps;
  const log = deps.logger.child({ component: TOOL_NAME });
  const cropDir = deps.cropDir ?? join(tmpdir(), 'pentaryn-prompts');

  /** Spec keys of dry runs seen by this backend — the gate for real runs over the threshold. */
  const dryRuns = new Set<string>();

  async function q(action: Action, data: any): Promise<any> {
    const method = QUERIES[action];
    try {
      return await foundryClient.query(method, data, { timeoutMs: TIMEOUTS[action] });
    } catch (err) {
      throw friendlyError(err, method);
    }
  }

  /** Crops → image blocks; also written to disk so a path exists if images are dropped. */
  function cropBlocks(call: string, crops: any[]): { blocks: McpContentBlock[]; notes: string[] } {
    const blocks: McpContentBlock[] = [];
    const notes: string[] = [];
    for (const c of crops ?? []) {
      const label = `${c?.encounter ?? '?'}${c?.scene ? ` (${c.scene})` : ''}${c?.squares ? ` ${c.squares} sq` : ''}`;
      if (typeof c?.png === 'string' && c.png.length) {
        // the module sends `mimeType` (and `mime`, its original name)
        const img = toImage(c.png, c.mimeType ?? c.mime);
        blocks.push({ type: 'text', text: `crop ${label}:` });
        blocks.push({ type: 'image', ...img });
        try {
          const dir = join(cropDir, safeSegment(call));
          mkdirSync(dir, { recursive: true });
          const file = join(
            dir,
            `${safeSegment(c.encounter ?? 'crop')}.${EXT[img.mimeType] ?? 'bin'}`
          );
          writeFileSync(file, Buffer.from(img.data, 'base64'));
          notes.push(`${label} → ${file}`);
        } catch (err) {
          notes.push(`${label} (inline only; file write failed: ${err})`);
        }
      } else if (typeof c?.path === 'string') {
        notes.push(`${label} → ${c.path}`);
      } else if (c?.error) {
        notes.push(`${label} failed: ${c.error}`);
      }
    }
    return { blocks, notes };
  }

  async function list(): Promise<string> {
    const res = await q('list', {});
    const scenes: any[] = res?.scenes ?? [];
    if (!scenes.length) return 'No prompt markers on any scene.';
    const total = scenes.reduce((n, s) => n + (s.prompts ?? 0), 0);
    const lines = scenes.map(
      s =>
        `- ${s.name}${s.nav && s.nav !== s.name ? ` ("${s.nav}")` : ''} [${s.id}] — ` +
        `${s.prompts ?? 0} prompt(s)${s.empty ? `, ${s.empty} empty` : ''}`
    );
    return `${total} prompt marker(s) on ${scenes.length} scene(s):\n${lines.join('\n')}`;
  }

  async function gather(args: any): Promise<any> {
    const payload = omit(args, 'action');
    const res = await q('gather', payload);
    if (typeof res?.text !== 'string') {
      // Not the contract shape — hand back what came, minus the bulky parts.
      return omit(res ?? {}, 'manifest', 'crops');
    }
    const call = String(res.call ?? 'pm-unknown');
    const { blocks, notes } = cropBlocks(call, res.crops);
    const trailer = [
      `call=${call} ${fmtCounts(res.counts)}${res.version ? ` module=${res.version}` : ''}`.trim(),
      res.next
        ? `next=${res.next} — more prompts than maxPrompts; gather again with scenes:["${res.next}"] ` +
          'and continue scene by scene (list gives the order).'
        : 'next=none — every requested scene is in the text.',
    ];
    if (notes.length) trailer.push(`crops: ${notes.join(' · ')}`);
    else
      trailer.push(
        typeof res.cropsNote === 'string' && res.cropsNote ? res.cropsNote : 'crops: none'
      );
    if (res.text.length > LONG_TEXT_CHARS) {
      trailer.push(
        `WARN text is ${res.text.length} chars — gather per scene to stay under the MCP output cap.`
      );
    }
    return {
      __mcpContent: [
        { type: 'text', text: res.text },
        ...blocks,
        { type: 'text', text: trailer.join('\n') },
      ],
      summary: `gather ${call}: ${fmtCounts(res.counts)}`,
    };
  }

  async function crops(args: any): Promise<any> {
    const res = await q('crops', { call: args.call, encounters: args.encounters });
    const { blocks, notes } = cropBlocks(args.call, res?.crops ?? []);
    return {
      __mcpContent: [
        ...blocks,
        {
          type: 'text',
          text: `call=${args.call} crops: ${notes.length ? notes.join(' · ') : 'none'}`,
        },
      ],
      summary: `crops ${args.call}: ${notes.length}`,
    };
  }

  async function show(args: any): Promise<string> {
    const res = await q('show', omit(args, 'action'));
    const what = args.id ? `${args.call} ${args.id}` : `${args.sceneId}/${args.markerId}`;
    return res?.ok === false
      ? `show ${what}: not shown${res?.error ? ` — ${res.error}` : ''}`
      : `Showing ${what} on scene ${res?.sceneId ?? '?'} at ${res?.x ?? '?'},${res?.y ?? '?'}.`;
  }

  async function replace(args: any): Promise<any> {
    const reps: ReplacementT[] = args.replacements.map((r: ReplacementT) => ({
      ...r,
      call: r.call ?? args.call,
    }));
    const key = specKey(args.call, reps, args.force);

    if (!args.dryRun && reps.length > DRY_RUN_THRESHOLD && !dryRuns.has(key)) {
      throw new Error(
        `DRY_RUN_REQUIRED: ${reps.length} replacements (over ${DRY_RUN_THRESHOLD}). Send the identical ` +
          'call with dryRun:true first, read the plan, then repeat it without dryRun.'
      );
    }

    let res: any;
    try {
      res = await q('replace', {
        call: args.call,
        replacements: reps,
        dryRun: !!args.dryRun,
        force: args.force,
        party: args.party,
        // This file is the dry-run gate (identical spec, above). The module keeps its own gate for
        // direct API use, keyed on the marker set and the GM page's lifetime; it would refuse here
        // after a GM-tab reload. So it is told to stand down.
        ...(args.dryRun ? {} : { skipDryRun: true }),
      });
    } catch (err: any) {
      if (args.dryRun) throw err;
      // Unknown outcome (timeout, dropped socket): the module may have built some of it already.
      throw new Error(
        `${err?.message ?? err} | the outcome is unknown: gather again (anything built shows as t# ` +
          'with its provenance, markers still standing show as p#) before re-running'
      );
    }
    if (args.dryRun) dryRuns.add(key);
    return render(args, reps, res);
  }

  /**
   * The module's readback, printed as it is (module 0.3.0+: `text`, flat `results`). A module that
   * predates it gets its results as JSON and a line saying to update.
   */
  function render(args: any, reps: ReplacementT[], res: any): any {
    const results: any[] = Array.isArray(res?.results) ? res.results : [];
    const ids = results.flatMap(r => (Array.isArray(r?.ids) ? r.ids : [])).filter(Boolean);
    const ok = results.filter(r => r?.ok).length;
    const mode = args.dryRun ? 'dry run' : 'real run';
    let text: string;
    if (typeof res?.text === 'string' && res.text.length) {
      text = res.text;
    } else {
      const raw = JSON.stringify(
        { plan: res?.plan, results: res?.results, remaining: res?.remaining },
        null,
        1
      ).slice(0, 20_000);
      text =
        `replace ${args.call ?? '(by marker)'} — ${mode}: module older than pentaryn-prompts 0.3.0 ` +
        `(no readback text); \`make foundry-prompts-sync\` and reload the GM tab. Raw result:\n${raw}`;
    }
    const summary = `replace ${args.call ?? '(by marker)'} — ${mode}: ${ok} ok, ${reps.length - ok} failed`;
    return { __mcpContent: [{ type: 'text', text }], summary, ids };
  }

  const RUN: Record<Action, (args: any) => Promise<any>> = {
    list: () => list(),
    gather,
    crops,
    replace,
    show,
  };

  return async function handle(raw: unknown): Promise<any> {
    const { action, args } = parseArgs(withSpecFile(raw));
    log.info(`prompt-markers ${action}`);
    return RUN[action](args);
  };
}

export function registerPromptMarkers(
  registry: ForkRegistry,
  foundryClient: FoundryClient,
  logger: Logger
): void {
  // The registry hands the same args object to the handler and to logArgs, so the file is read
  // once, at the start of the call, and the log shows what ran even if it changes mid-call.
  const read = new WeakMap<object, any>();
  const handle = createPromptMarkersHandler({ foundryClient, logger });
  const handler = async (raw: any) => {
    const x = withSpecFile(raw);
    if (raw && typeof raw === 'object') read.set(raw, x);
    return handle(x);
  };
  registry.register(DEFINITION, handler, {
    // Only replace writes; a dry run is logged too, so the log shows the plan that preceded it.
    write: (args: any) => args?.action === 'replace',
    // A specFile is edited and deleted after use (prompt-markers.md), so log what it held,
    // not just its path. An unreadable file logs the raw args (the call fails anyway).
    logArgs: (args: any) => {
      try {
        const expanded =
          args && typeof args === 'object' && read.has(args) ? read.get(args) : withSpecFile(args);
        return expanded === args ? args : { ...expanded, specFile: args.specFile };
      } catch {
        return args;
      }
    },
  });
}

export { DEFINITION as PROMPT_MARKERS_DEFINITION };
