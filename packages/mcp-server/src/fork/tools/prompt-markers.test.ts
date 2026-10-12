import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPromptMarkersHandler,
  friendlyError,
  parseArgs,
  specKey,
  toImage,
  withSpecFile,
  QUERIES,
  TIMEOUTS,
  PROMPT_MARKERS_DEFINITION,
  registerPromptMarkers,
} from './prompt-markers.js';
import { toMcpPayload } from '../content.js';
import { ForkRegistry } from '../registry.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

// 1x1 transparent webp, base64
const WEBP = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function setup(responses: Record<string, any> = {}, extra: Partial<any> = {}) {
  const calls: { method: string; data: any; opts: any }[] = [];
  const query = vi.fn(async (method: string, data?: any, opts?: any) => {
    calls.push({ method, data, opts });
    const r = responses[method];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(data);
    if (r === undefined) throw new Error(`unexpected query ${method}`);
    return r;
  });
  const cropDir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  const handle = createPromptMarkersHandler({
    foundryClient: { query } as any,
    logger,
    cropDir,
    ...extra,
  });
  return { handle, calls, query, cropDir };
}

const textOf = (res: any) =>
  (res.__mcpContent ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

describe('argument validation', () => {
  it('rejects an unknown action with the action list', () => {
    expect(() => parseArgs({ action: 'nuke' })).toThrow(/BAD_SPEC: action must be one of list/);
  });

  it('rejects stray fields on an action (strict)', () => {
    expect(() => parseArgs({ action: 'list', scenes: 'all' })).toThrow(/BAD_SPEC/);
  });

  it('wraps a single scene name into a list', () => {
    expect(parseArgs({ action: 'gather', scenes: 'Goblin Warren' }).args.scenes).toEqual([
      'Goblin Warren',
    ]);
    expect(parseArgs({ action: 'gather', scenes: 'all' }).args.scenes).toBe('all');
    expect(parseArgs({ action: 'gather', scenes: 'current' }).args.scenes).toBe('current');
  });

  it('requires a call for gather ids', () => {
    expect(() =>
      parseArgs({
        action: 'replace',
        replacements: [{ id: 'p1', with: { kind: 'none', reason: 'x' } }],
      })
    ).toThrow(/needs the gather's call id/);
    expect(
      parseArgs({
        action: 'replace',
        call: 'pm-1a2b',
        replacements: [{ id: 'p1', with: { kind: 'none', reason: 'x' } }],
      }).args.replacements
    ).toHaveLength(1);
  });

  it('accepts sceneId + markerId without a call', () => {
    expect(() =>
      parseArgs({
        action: 'replace',
        replacements: [{ sceneId: 's', markerId: 'm', with: { kind: 'none', reason: 'x' } }],
      })
    ).not.toThrow();
  });

  it('refuses the same marker twice', () => {
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [
          { id: 'p1', with: { kind: 'none', reason: 'a' } },
          { id: 'p1', with: { kind: 'none', reason: 'b' } },
        ],
      })
    ).toThrow(/replaced twice/);
  });

  it('actor needs exactly one of actorId or uuid', () => {
    const base = { action: 'replace', call: 'pm-1' };
    expect(() =>
      parseArgs({ ...base, replacements: [{ id: 'p1', with: { kind: 'actor' } }] })
    ).toThrow(/exactly one of actorId or uuid/);
    expect(() =>
      parseArgs({
        ...base,
        replacements: [{ id: 'p1', with: { kind: 'actor', actorId: 'a', uuid: 'b' } }],
      })
    ).toThrow(/exactly one/);
  });

  it('names the bad field of a misspelt kind payload', () => {
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { kind: 'hotspot', name: 'Chest', descripton: 'x' } }],
      })
    ).toThrow(/replacements\.0\.with/);
  });

  it('validates npc size and feature types', () => {
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { kind: 'npc', npc: { name: 'Ogre', size: 'lg' } } }],
      })
    ).toThrow(/size/);
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [
          {
            id: 'p1',
            with: {
              kind: 'npc',
              npc: { name: 'Ogre', size: 'large', cr: '2' },
              features: [{ featureType: 'dance' }],
            },
          },
        ],
      })
    ).toThrow(/featureType/);
  });

  it('crops wants E# ids, show wants call+id or scene+marker', () => {
    expect(() => parseArgs({ action: 'crops', call: 'pm-1', encounters: ['p1'] })).toThrow(/E1/);
    expect(() => parseArgs({ action: 'show', call: 'pm-1' })).toThrow(/show needs/);
    expect(() => parseArgs({ action: 'show', sceneId: 's', markerId: 'm' })).not.toThrow();
  });

  it('the JSON schema lists every action', () => {
    expect((PROMPT_MARKERS_DEFINITION.inputSchema.properties as any).action.enum).toEqual([
      'list',
      'gather',
      'crops',
      'replace',
      'show',
    ]);
  });
});

describe('helpers', () => {
  it('toImage splits data URLs and defaults raw base64 to webp', () => {
    expect(toImage(`data:image/png;base64,${WEBP}`)).toEqual({ data: WEBP, mimeType: 'image/png' });
    expect(toImage(WEBP)).toEqual({ data: WEBP, mimeType: 'image/webp' });
    expect(toImage(WEBP, 'image/jpeg').mimeType).toBe('image/jpeg');
  });

  it('friendlyError surfaces the module code and names the missing module', () => {
    expect(
      friendlyError(
        new Error('Query pentaryn-prompts.replace failed: TEXT_CHANGED: p3 edited'),
        QUERIES.replace
      ).message
    ).toBe('TEXT_CHANGED: p3 edited');
    expect(
      friendlyError(
        new Error(
          'Query pentaryn-prompts.gather failed: No handler found for query: pentaryn-prompts.gather'
        ),
        QUERIES.gather
      ).message
    ).toMatch(/^MODULE_MISSING: .*make foundry-prompts-sync/);
    expect(
      friendlyError(
        new Error(
          'Query pentaryn-prompts.gather failed: Query timeout: pentaryn-prompts.gather (60000 ms)'
        ),
        QUERIES.gather
      ).message
    ).toMatch(/^TIMEOUT: /);
  });

  it('specKey ignores nothing but dryRun', () => {
    const r = [{ id: 'p1', call: 'pm-1', with: { kind: 'none', reason: 'x' } }];
    expect(specKey('pm-1', r)).toBe(specKey('pm-1', JSON.parse(JSON.stringify(r))));
    expect(specKey('pm-1', r)).not.toBe(specKey('pm-1', r, true));
    expect(specKey('pm-1', r)).not.toBe(specKey('pm-2', r));
  });
});

describe('list / show', () => {
  it('formats the scene list and uses the short timeout', async () => {
    const { handle, calls } = setup({
      [QUERIES.list]: {
        scenes: [
          { id: 'S1', name: 'Goblin Warren', nav: 'The Warren', prompts: 5, empty: 1 },
          { id: 'S2', name: 'Inn', nav: '', prompts: 2, empty: 0 },
        ],
      },
    });
    const out = await handle({ action: 'list' });
    expect(out).toContain('7 prompt marker(s) on 2 scene(s)');
    expect(out).toContain('- Goblin Warren ("The Warren") [S1] — 5 prompt(s), 1 empty');
    expect(out).toContain('- Inn [S2] — 2 prompt(s)');
    expect(calls[0].opts).toEqual({ timeoutMs: TIMEOUTS.list });
  });

  it('show passes call+id through', async () => {
    const { handle, calls } = setup({ [QUERIES.show]: { ok: true, sceneId: 'S1', x: 10, y: 20 } });
    const out = await handle({ action: 'show', call: 'pm-1', id: 'p3' });
    expect(calls[0].data).toEqual({ call: 'pm-1', id: 'p3' });
    expect(out).toBe('Showing pm-1 p3 on scene S1 at 10,20.');
  });
});

describe('gather', () => {
  it('returns the text first, crops as image blocks, a trailer last; never the manifest', async () => {
    const { handle, calls, cropDir } = setup({
      [QUERIES.gather]: {
        call: 'pm-7f3a',
        text: '<prompt_markers call="pm-7f3a">…</prompt_markers>',
        counts: { scenes: 1, prompts: 3, built: 1, encounters: 1, alone: 1 },
        manifest: { call: 'pm-7f3a', prompts: { p1: { markerId: 'SECRETMARKERID16' } } },
        crops: [
          { encounter: 'E1', scene: 's1', png: `data:image/webp;base64,${WEBP}`, squares: '12x9' },
        ],
        next: null,
        version: '0.3.0',
      },
    });
    const res = await handle({ action: 'gather', scenes: ['Goblin Warren'], crops: 'auto' });
    const blocks = res.__mcpContent;
    expect(blocks[0]).toEqual({
      type: 'text',
      text: '<prompt_markers call="pm-7f3a">…</prompt_markers>',
    });
    const img = blocks.find((b: any) => b.type === 'image');
    expect(img).toEqual({ type: 'image', data: WEBP, mimeType: 'image/webp' });
    const last = blocks[blocks.length - 1].text;
    expect(last).toContain(
      'call=pm-7f3a scenes=1 prompts=3 built=1 encounters=1 alone=1 module=0.3.0'
    );
    expect(last).toContain('next=none');
    expect(JSON.stringify(res)).not.toContain('SECRETMARKERID16');
    // file fallback written
    const file = join(cropDir, 'pm-7f3a', 'E1.webp');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).toString('base64')).toBe(WEBP);
    expect(last).toContain(file);
    // action stripped, timeout 60 s
    expect(calls[0].data).toEqual({ scenes: ['Goblin Warren'], crops: 'auto' });
    expect(calls[0].opts).toEqual({ timeoutMs: 60_000 });
    // and the backend passes those blocks through as-is
    expect(toMcpPayload(res).content).toBe(blocks);
    rmSync(cropDir, { recursive: true, force: true });
  });

  it('says how to page when next is set, and lists module-side crop paths', async () => {
    const { handle } = setup({
      [QUERIES.gather]: {
        call: 'pm-0001',
        text: 'x',
        counts: { scenes: 3, prompts: 60 },
        crops: [{ encounter: 'E2', path: '/tmp/pentaryn-prompts/pm-0001/E2.webp' }],
        next: 'SCENE3',
      },
    });
    const t = textOf(await handle({ action: 'gather' }));
    expect(t).toContain('next=SCENE3');
    expect(t).toContain('scenes:["SCENE3"]');
    expect(t).toContain('E2 → /tmp/pentaryn-prompts/pm-0001/E2.webp');
  });

  it("prints the module's crops note when it skipped crops (a scene with no art)", async () => {
    const { handle } = setup({
      [QUERIES.gather]: {
        call: 'pm-c',
        text: '<prompt_markers/>',
        counts: { scenes: 1, prompts: 1 },
        crops: [],
        next: null,
        cropsNote:
          'crops: skipped — the scene has no background image or tiles, a crop would be blank',
      },
    });
    const res = await handle({ action: 'gather' });
    expect(textOf(res)).toMatch(/crops: skipped — the scene has no background image/);
  });

  it('turns a missing module into MODULE_MISSING', async () => {
    const { handle } = setup({
      [QUERIES.gather]: new Error(
        'Query pentaryn-prompts.gather failed: No handler found for query: pentaryn-prompts.gather'
      ),
    });
    await expect(handle({ action: 'gather' })).rejects.toThrow(/^MODULE_MISSING/);
  });

  it('crops action maps images the same way', async () => {
    const { handle, calls } = setup({
      [QUERIES.crops]: { crops: [{ encounter: 'E3', png: WEBP }] },
    });
    const res = await handle({ action: 'crops', call: 'pm-7f3a', encounters: ['E3'] });
    expect(res.__mcpContent.some((b: any) => b.type === 'image')).toBe(true);
    expect(calls[0].data).toEqual({ call: 'pm-7f3a', encounters: ['E3'] });
    expect(calls[0].opts).toEqual({ timeoutMs: TIMEOUTS.crops });
  });

  it("reads the module's own crop shape: raw base64 with mime / mimeType", async () => {
    const { handle } = setup({
      [QUERIES.crops]: {
        crops: [
          { encounter: 'E1', png: WEBP, mime: 'image/png' },
          { encounter: 'E2', png: WEBP, mime: 'image/webp', mimeType: 'image/jpeg' },
        ],
      },
    });
    const res = await handle({ action: 'crops', call: 'pm-7f3a', encounters: ['E1', 'E2'] });
    const imgs = res.__mcpContent.filter((b: any) => b.type === 'image');
    expect(imgs.map((b: any) => b.mimeType)).toEqual(['image/png', 'image/jpeg']);
  });
});

describe('replace', () => {
  const none = (id: string) => ({ id, with: { kind: 'none', reason: 'cut' } });
  /** A module 0.3.0 result: flat rows and the readback text it renders. */
  const moduleResult = (d: any, extra: any = {}) => {
    const rows = d.replacements.map((r: any, i: number) => ({
      index: i,
      id: r.id,
      label: r.id,
      kind: r.with.kind,
      ok: true,
      created: [`Token "${String(r.id).toUpperCase()}" [T${r.id}] @100,200 1x1`],
      ids: [`T${r.id}`],
      markerDeleted: true,
    }));
    const head = `replace ${d.call} — ${d.dryRun ? 'dry run' : 'real run'}: ${rows.length} ok, 0 failed`;
    const lines = rows.map((r: any) => `${r.label} → ${r.created[0]}; markerDeleted=true`);
    return {
      dryRun: !!d.dryRun,
      call: d.call,
      text: [head, ...lines, 'remaining: S1=0'].join('\n'),
      results: rows,
      remaining: { S1: 0 },
      encounters: [],
      ...extra,
    };
  };

  it('dry run forwards the spec with call filled in and prints the module readback', async () => {
    const { handle, calls } = setup({
      [QUERIES.replace]: () => ({
        dryRun: true,
        text: 'replace pm-1 — dry run: 1 ok, 0 failed\np1 npc: at 100,200 (snapped), footprint 2x2; creates Actor (NPC "Ogre")\nNothing was written.',
        results: [
          {
            index: 0,
            id: 'p1',
            label: 'p1',
            kind: 'npc',
            ok: true,
            creates: ['Actor (NPC "Ogre")'],
          },
        ],
        remaining: { S1: 1 },
      }),
    });
    const res = await handle({
      action: 'replace',
      call: 'pm-1',
      dryRun: true,
      replacements: [{ id: 'p1', with: { kind: 'npc', npc: { name: 'Ogre', size: 'large' } } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].data.dryRun).toBe(true);
    expect(calls[0].data.skipDryRun).toBeUndefined();
    expect(calls[0].data.replacements[0]).toMatchObject({ call: 'pm-1', with: { kind: 'npc' } });
    const t = textOf(res);
    expect(t).toBe(
      'replace pm-1 — dry run: 1 ok, 0 failed\np1 npc: at 100,200 (snapped), footprint 2x2; creates Actor (NPC "Ogre")\nNothing was written.'
    );
    expect(res.summary).toBe('replace pm-1 — dry run: 1 ok, 0 failed');
  });

  it(`refuses a real batch over 5 without the identical dry run, then allows it`, async () => {
    const reps = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(none);
    const { handle, calls } = setup({ [QUERIES.replace]: (d: any) => moduleResult(d) });
    await expect(handle({ action: 'replace', call: 'pm-1', replacements: reps })).rejects.toThrow(
      /^DRY_RUN_REQUIRED/
    );
    expect(calls).toHaveLength(0);
    await handle({ action: 'replace', call: 'pm-1', replacements: reps, dryRun: true });
    // a different spec is not covered by that dry run
    await expect(
      handle({ action: 'replace', call: 'pm-1', replacements: reps, force: true })
    ).rejects.toThrow(/^DRY_RUN_REQUIRED/);
    const res = await handle({ action: 'replace', call: 'pm-1', replacements: reps });
    expect(calls.at(-1)!.data.skipDryRun).toBe(true);
    const t = textOf(res);
    expect(t).toContain('real run: 6 ok, 0 failed');
    expect(t).toContain('remaining: S1=0');
    expect(res.ids).toEqual(['Tp1', 'Tp2', 'Tp3', 'Tp4', 'Tp5', 'Tp6']);
  });

  it('passes npc through untouched: the module builds it (eval-js parity)', async () => {
    const { handle, calls } = setup({ [QUERIES.replace]: (d: any) => moduleResult(d) });
    const npc = { name: 'Stone Guardian', creatureType: 'construct', size: 'large', cr: '4' };
    const features = [{ featureType: 'save', featureName: 'Earthsplitter', recharge: 5 }];
    await handle({
      action: 'replace',
      call: 'pm-1',
      replacements: [
        {
          id: 'p8',
          note: 'guardian',
          with: { kind: 'npc', npc, features, patch: { biography: '<p>x</p>' } },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe(QUERIES.replace);
    expect(calls[0].data.replacements[0]).toEqual({
      id: 'p8',
      call: 'pm-1',
      note: 'guardian',
      with: { kind: 'npc', npc, features, patch: { biography: '<p>x</p>' } },
    });
  });

  it("prints the module text verbatim (sheet, DEFAULTED, encounter lines are the module's)", async () => {
    const text = [
      'replace pm-1 — real run: 1 ok, 1 failed',
      'p9 → Token "Hale" [T9] @100,200 1x1, Actor "Hale" [A9]; markerDeleted=true',
      '  p9 sheet: Paladin 5 (Oath of Devotion), Human, Soldier; str 18; HP 54 AC 19 PB +3 spell DC 13 (cha)',
      '  p9 DEFAULTED (check): Soldier: Choose Languages: picked Elvish',
      'p2 npc: FAIL BAD_SPEC: npc.acValue is required when acMode is "flat" (markerDeleted=false)',
      'remaining: S1=1',
      'E1: 325 XP from 5 creature(s) vs party 4 x L2: low 400 | moderate 600 | high 800 → under low',
    ].join('\n');
    const { handle } = setup({
      [QUERIES.replace]: {
        text,
        results: [
          { id: 'p9', ok: true, ids: ['T9', 'A9'] },
          { id: 'p2', ok: false, ids: [] },
        ],
        remaining: { S1: 1 },
      },
    });
    const res = await handle({
      action: 'replace',
      call: 'pm-1',
      replacements: [none('p9'), none('p2')],
    });
    expect(textOf(res)).toBe(text);
    expect(res.ids).toEqual(['T9', 'A9']);
    expect(res.summary).toBe('replace pm-1 — real run: 1 ok, 1 failed');
  });

  it('accepts a character, a patched stock monster, inline items, ring and party', () => {
    const { args } = parseArgs({
      action: 'replace',
      call: 'pm-1',
      party: '4x5',
      replacements: [
        {
          id: 'p9',
          ring: 'pc',
          with: {
            kind: 'character',
            name: 'Hale',
            level: 5,
            class: 'Paladin',
            subclass: 'Oath of Devotion',
            species: 'Human',
            background: 'Soldier',
            abilities: { str: 15, dex: 10, con: 13, int: 8, wis: 12, cha: 14 },
            choices: { 'Background Ability Score Improvement': { str: 2, con: 1 } },
            spells: ['Bless'],
            items: [
              'Chain Mail',
              { name: 'Javelin', quantity: 4 },
              { data: { name: 'Prayer Beads', type: 'loot' } },
            ],
          },
        },
        {
          id: 'p3',
          ring: 'foe',
          with: {
            kind: 'actor',
            uuid: 'Compendium.x.Actor.y',
            patch: {
              name: 'Yark',
              removeItems: ['Scimitar'],
              addItems: [{ name: 'Spear' }],
              traits: [{ name: 'Sound the Horn', activation: 'bonus', recharge: 5 }],
              creatureType: 'construct',
              languages: ['Common', 'goblin'],
            },
          },
        },
        {
          id: 'p7',
          with: {
            kind: 'hotspot',
            name: 'Plinth',
            description: 'x',
            items: [
              { data: { name: 'Ember Crown', type: 'equipment' } },
              { name: 'Torch', quantity: 2 },
            ],
          },
        },
      ],
    });
    expect(args.replacements).toHaveLength(3);
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { kind: 'actor', uuid: 'u', patch: { nonsense: 1 } } }],
      })
    ).toThrow(/BAD_SPEC: .*patch/);
    expect(() => parseArgs({ action: 'gather', party: 'lots' })).toThrow(/party like/);
  });

  it('accepts startingEquipment on a character and a light on a hotspot or note (eval round 3)', () => {
    const base = {
      kind: 'character',
      name: 'Brunna',
      level: 5,
      class: 'Cleric',
      subclass: 'Life Domain',
      species: 'Dwarf',
      background: 'Acolyte',
      abilities: { str: 14, dex: 8, con: 13, int: 10, wis: 15, cha: 12 },
    };
    for (const se of ['A', 'b', 'none', true, { class: 'A', background: 'B' }]) {
      const { args } = parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { ...base, startingEquipment: se } }],
      });
      expect(args.replacements[0].with.startingEquipment).toEqual(se);
    }
    expect(() =>
      parseArgs({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { ...base, startingEquipment: 'C' } }],
      })
    ).toThrow(/BAD_SPEC: .*startingEquipment/);
    const { args } = parseArgs({
      action: 'replace',
      call: 'pm-1',
      replacements: [
        {
          id: 'p2',
          with: {
            kind: 'hotspot',
            name: 'Relic',
            description: 'x',
            light: { dim: 5, color: '#9fd3ff', animation: { type: 'pulse' } },
          },
        },
        { id: 'p3', with: { kind: 'note', name: 'Altar', html: '<p>x</p>', light: { dim: 10 } } },
      ],
    });
    expect(args.replacements[0].with.light.dim).toBe(5);
    expect(args.replacements[1].with.light.dim).toBe(10);
  });

  it('passes what the module accepts: a character folder and a fractional CR as "1/2" (PT PR-2)', () => {
    const { args } = parseArgs({
      action: 'replace',
      call: 'pm-1',
      replacements: [
        {
          id: 'p1',
          with: {
            kind: 'character',
            name: 'Zed',
            level: 5,
            class: 'Sorcerer',
            species: 'Human',
            background: 'Charlatan',
            abilities: { cha: 15 },
            folder: 'ZZ usability',
          },
        },
        { id: 'p2', with: { kind: 'actor', uuid: 'u', patch: { cr: '1/2' } } },
        { id: 'p3', with: { kind: 'actor', uuid: 'u', patch: { cr: 0.25 } } },
        { id: 'p4', with: { kind: 'actor', uuid: 'u', patch: { cr: '3' } } },
      ],
    });
    expect(args.replacements[0].with.folder).toBe('ZZ usability');
    expect(args.replacements.slice(1).map((r: any) => r.with.patch.cr)).toEqual(['1/2', 0.25, '3']);
    for (const cr of ['half', '1/0', -1, 31, '40']) {
      expect(() =>
        parseArgs({
          action: 'replace',
          call: 'pm-1',
          replacements: [{ id: 'p2', with: { kind: 'actor', uuid: 'u', patch: { cr } } }],
        })
      ).toThrow(/BAD_SPEC: .*cr/);
    }
  });

  it('a non-string specFile fails as specFile: Expected string', () => {
    expect(() =>
      parseArgs({ action: 'replace', call: 'pm-1', specFile: 3, replacements: [none('p1')] })
    ).toThrow(/^BAD_SPEC: .*specFile: Expected string/);
  });

  it('specFile: reads the replacements from a JSON file; the call keeps dryRun and wins on call/party', async () => {
    const files: Record<string, string> = {
      '/s/arr.json': JSON.stringify([none('p1')]),
      '/s/obj.json': JSON.stringify({
        call: 'pm-f',
        party: '4x3',
        dryRun: false,
        replacements: [none('p2')],
      }),
      '/s/bad.json': '{replacements: [ ]}',
    };
    const read = (p: string) => {
      if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return files[p];
    };
    const a = withSpecFile(
      { action: 'replace', call: 'pm-1', specFile: '/s/arr.json', dryRun: true },
      read
    );
    expect(a).toEqual({
      action: 'replace',
      call: 'pm-1',
      dryRun: true,
      replacements: [none('p1')],
    });
    const b = withSpecFile({ action: 'replace', specFile: '/s/obj.json', dryRun: true }, read);
    expect(b).toEqual({
      action: 'replace',
      call: 'pm-f',
      party: '4x3',
      dryRun: true,
      replacements: [none('p2')],
    });
    expect(() => withSpecFile({ action: 'replace', specFile: 'rel.json' }, read)).toThrow(
      /absolute/
    );
    expect(() => withSpecFile({ action: 'replace', specFile: '/s/missing.json' }, read)).toThrow(
      /ENOENT/
    );
    expect(() => withSpecFile({ action: 'replace', specFile: '/s/bad.json' }, read)).toThrow(
      /not JSON/
    );
    // other actions pass through untouched
    expect(withSpecFile({ action: 'gather', specFile: '/s/arr.json' }, read)).toEqual({
      action: 'gather',
      specFile: '/s/arr.json',
    });

    // end to end through the handler, from a real temp file
    const dir = mkdtempSync(join(tmpdir(), 'pm-spec-'));
    const file = join(dir, 'spec.json');
    writeFileSync(file, JSON.stringify({ call: 'pm-9', replacements: [none('p4')] }));
    const { handle, calls } = setup({ [QUERIES.replace]: (d: any) => moduleResult(d) });
    const res = await handle({ action: 'replace', specFile: file, dryRun: true });
    expect(calls[0].data.call).toBe('pm-9');
    expect(calls[0].data.dryRun).toBe(true);
    expect(calls[0].data.replacements[0].id).toBe('p4');
    expect(calls[0].data.specFile).toBeUndefined();
    expect(textOf(res)).toMatch(/dry run/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a transport failure on a real run says the outcome is unknown and how to check', async () => {
    const { handle } = setup({
      [QUERIES.replace]: new Error(
        'Query pentaryn-prompts.replace failed: Query timeout: pentaryn-prompts.replace (60000 ms)'
      ),
    });
    await expect(
      handle({
        action: 'replace',
        call: 'pm-1',
        replacements: [{ id: 'p1', with: { kind: 'npc', npc: { name: 'Ogre', size: 'large' } } }],
      })
    ).rejects.toThrow(/^TIMEOUT: .*outcome is unknown: gather again/);
  });

  it('an older module (no text) is named, with its raw result', async () => {
    const { handle } = setup({
      [QUERIES.replace]: {
        results: [{ id: 'p1', ok: true, created: [{ type: 'Token', id: 'T1' }] }],
        remaining: { S1: 0 },
      },
    });
    const t = textOf(await handle({ action: 'replace', call: 'pm-1', replacements: [none('p1')] }));
    expect(t).toContain('module older than pentaryn-prompts 0.3.0');
    expect(t).toContain('"T1"');
  });
});

describe('schema characterisation (mcp-fork-14)', () => {
  // Frozen before the schema block moved to prompt-markers.schema.ts: every input's parse
  // result or BAD_SPEC text must stay byte-identical.
  const run = (raw: unknown) => {
    try {
      return { ok: true, data: parseArgs(raw).args };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  };
  const rep = (w: any, extra: any = {}) => ({
    action: 'replace',
    call: 'pm-1',
    replacements: [{ id: 'p1', with: w, ...extra }],
  });
  const npc = { kind: 'npc', npc: { name: 'Ogre', size: 'large' } };
  const table: [string, unknown][] = [
    ['actor', rep({ kind: 'actor', actorId: 'A1', patch: { hp: 20, size: 'large' } })],
    ['npc', rep({ ...npc, features: [{ featureType: 'attack', recharge: 5 }] })],
    [
      'character',
      rep({
        kind: 'character',
        name: 'Esren',
        level: 3,
        class: 'Wizard',
        species: 'Elf',
        background: 'Sage',
        abilities: { int: 15 },
        items: ['Dagger', { name: 'Rope' }, { data: { name: 'X' } }],
        startingEquipment: { class: 'A' },
      }),
    ],
    ['hotspot', rep({ kind: 'hotspot', name: 'Chest', description: 'd', items: [{ data: {} }] })],
    ['note', rep({ kind: 'note', name: 'N', html: '<p>x</p>', ownership: 'observer' })],
    ['light', rep({ kind: 'light', config: { dim: 10 } })],
    ['tile', rep({ kind: 'tile', src: 'a.webp', width: 2 })],
    ['none', rep({ kind: 'none', reason: 'cut' })],
    ['actor unknown key', rep({ kind: 'actor', actorId: 'A1', bogus: 1 })],
    ['npc unknown key', rep({ ...npc, bogus: 1 })],
    ['character unknown key', rep({ kind: 'character', name: 'E', bogus: 1 })],
    ['hotspot unknown key', rep({ kind: 'hotspot', name: 'C', description: 'd', bogus: 1 })],
    ['note unknown key', rep({ kind: 'note', name: 'N', html: '', bogus: 1 })],
    ['light unknown key', rep({ kind: 'light', config: {}, bogus: 1 })],
    ['tile unknown key', rep({ kind: 'tile', src: 's', bogus: 1 })],
    ['none unknown key', rep({ kind: 'none', reason: 'r', bogus: 1 })],
    ['patch.size lg', rep({ kind: 'actor', actorId: 'A1', patch: { size: 'lg' } })],
    ['npc.size lg', rep({ kind: 'npc', npc: { name: 'O', size: 'lg' } })],
    [
      'addItems data quantity 0',
      rep({ kind: 'actor', actorId: 'A1', patch: { addItems: [{ data: {}, quantity: 0 }] } }),
    ],
    [
      'addItems name only',
      rep({ kind: 'actor', actorId: 'A1', patch: { addItems: [{ name: 'Rope' }] } }),
    ],
    [
      'patch disposition evil',
      rep({ kind: 'actor', actorId: 'A1', patch: { disposition: 'evil' } }),
    ],
    ['replacement disposition evil', rep({ kind: 'none', reason: 'r' }, { disposition: 'evil' })],
    ['party 4x5', { action: 'gather', party: '4x5' }],
    ['party object', { action: 'gather', party: { size: 4, level: 5 } }],
    ['party list', { action: 'gather', party: [3, 3, 4] }],
    ['party bad', { action: 'gather', party: '4 by 5' }],
    ['scenes string', { action: 'gather', scenes: 'Goblin Warren' }],
    ['crops with p1', { action: 'crops', call: 'pm-1', encounters: ['p1'] }],
    ['show without id', { action: 'show', call: 'pm-1' }],
    ['unknown kind', rep({ kind: 'wall' })],
  ];

  it('parses the fixed table identically', () => {
    expect(Object.fromEntries(table.map(([k, v]) => [k, run(v)]))).toMatchInlineSnapshot(`
      {
        "actor": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "actorId": "A1",
                  "kind": "actor",
                  "patch": {
                    "hp": 20,
                    "size": "large",
                  },
                },
              },
            ],
          },
          "ok": true,
        },
        "actor unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "addItems data quantity 0": {
          "message": "BAD_SPEC: replacements.0.with.patch.addItems.0.quantity: Number must be greater than or equal to 1; replacements.0.with.patch.addItems.0: Unrecognized key(s) in object: 'data'; replacements.0.with.patch.addItems.0: item needs uuid or name",
          "ok": false,
        },
        "addItems name only": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "actorId": "A1",
                  "kind": "actor",
                  "patch": {
                    "addItems": [
                      {
                        "name": "Rope",
                      },
                    ],
                  },
                },
              },
            ],
          },
          "ok": true,
        },
        "character": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "abilities": {
                    "int": 15,
                  },
                  "background": "Sage",
                  "class": "Wizard",
                  "items": [
                    "Dagger",
                    {
                      "name": "Rope",
                    },
                    {
                      "data": {
                        "name": "X",
                      },
                    },
                  ],
                  "kind": "character",
                  "level": 3,
                  "name": "Esren",
                  "species": "Elf",
                  "startingEquipment": {
                    "class": "A",
                  },
                },
              },
            ],
          },
          "ok": true,
        },
        "character unknown key": {
          "message": "BAD_SPEC: replacements.0.with.level: Required; replacements.0.with.class: Required; replacements.0.with.species: Required; replacements.0.with.background: Required; replacements.0.with.abilities: Required; replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "crops with p1": {
          "message": "BAD_SPEC: encounters.0: expected an encounter id like "E1"",
          "ok": false,
        },
        "hotspot": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "description": "d",
                  "items": [
                    {
                      "data": {},
                    },
                  ],
                  "kind": "hotspot",
                  "name": "Chest",
                },
              },
            ],
          },
          "ok": true,
        },
        "hotspot unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "light": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "config": {
                    "dim": 10,
                  },
                  "kind": "light",
                },
              },
            ],
          },
          "ok": true,
        },
        "light unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "none": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "kind": "none",
                  "reason": "cut",
                },
              },
            ],
          },
          "ok": true,
        },
        "none unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "note": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "html": "<p>x</p>",
                  "kind": "note",
                  "name": "N",
                  "ownership": "observer",
                },
              },
            ],
          },
          "ok": true,
        },
        "note unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "npc": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "features": [
                    {
                      "featureType": "attack",
                      "recharge": 5,
                    },
                  ],
                  "kind": "npc",
                  "npc": {
                    "name": "Ogre",
                    "size": "large",
                  },
                },
              },
            ],
          },
          "ok": true,
        },
        "npc unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "npc.size lg": {
          "message": "BAD_SPEC: replacements.0.with.npc.size: Invalid enum value. Expected 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan', received 'lg'",
          "ok": false,
        },
        "party 4x5": {
          "data": {
            "action": "gather",
            "party": "4x5",
          },
          "ok": true,
        },
        "party bad": {
          "message": "BAD_SPEC: party: party like "4x5" (size x level)",
          "ok": false,
        },
        "party list": {
          "data": {
            "action": "gather",
            "party": [
              3,
              3,
              4,
            ],
          },
          "ok": true,
        },
        "party object": {
          "data": {
            "action": "gather",
            "party": {
              "level": 5,
              "size": 4,
            },
          },
          "ok": true,
        },
        "patch disposition evil": {
          "message": "BAD_SPEC: replacements.0.with.patch.disposition: Invalid enum value. Expected 'hostile' | 'neutral' | 'friendly' | 'secret', received 'evil'",
          "ok": false,
        },
        "patch.size lg": {
          "message": "BAD_SPEC: replacements.0.with.patch.size: Invalid enum value. Expected 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan', received 'lg'",
          "ok": false,
        },
        "replacement disposition evil": {
          "message": "BAD_SPEC: replacements.0.disposition: Invalid enum value. Expected 'hostile' | 'neutral' | 'friendly' | 'secret', received 'evil'",
          "ok": false,
        },
        "scenes string": {
          "data": {
            "action": "gather",
            "scenes": [
              "Goblin Warren",
            ],
          },
          "ok": true,
        },
        "show without id": {
          "message": "BAD_SPEC: (args): show needs call + id, or sceneId + markerId",
          "ok": false,
        },
        "tile": {
          "data": {
            "action": "replace",
            "call": "pm-1",
            "replacements": [
              {
                "id": "p1",
                "with": {
                  "kind": "tile",
                  "src": "a.webp",
                  "width": 2,
                },
              },
            ],
          },
          "ok": true,
        },
        "tile unknown key": {
          "message": "BAD_SPEC: replacements.0.with: Unrecognized key(s) in object: 'bogus'",
          "ok": false,
        },
        "unknown kind": {
          "message": "BAD_SPEC: replacements.0.with.kind: Invalid discriminator value. Expected 'actor' | 'npc' | 'character' | 'hotspot' | 'note' | 'light' | 'tile' | 'none'",
          "ok": false,
        },
      }
    `);
  });
});

describe('registry logging', () => {
  beforeEach(() => {
    delete process.env.PENTARYN_MCP_LOG_DIR;
  });

  it('logs only the actions the predicate marks as writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-log-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    const reg = new ForkRegistry(logger);
    reg.register(
      { name: 't', description: '', inputSchema: {} },
      async (a: any) => ({ summary: `did ${a.action}` }),
      { write: (a: any) => a.action === 'replace' }
    );
    await reg.dispatch('t', { action: 'gather' });
    await reg.dispatch('t', { action: 'replace' });
    const month = new Date().toISOString().slice(0, 7);
    const lines = readFileSync(join(dir, `mcp-${month}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      tool: 't',
      action: 'replace',
      summary: 'did replace',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a specFile replace logs the expanded spec and the path (mcp-fork-16)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-log16-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    const file = join(dir, 'spec.json');
    const none = (id: string) => ({ id, with: { kind: 'none', reason: 'cut' } });
    writeFileSync(file, JSON.stringify({ call: 'pm-9', replacements: [none('p4')] }));
    const answer = (d: any) => ({
      dryRun: !!d.dryRun,
      call: d.call,
      text: `replace ${d.call} — dry run: 1 ok, 0 failed`,
      results: [{ index: 0, id: 'p4', label: 'p4', kind: 'none', ok: true, created: [], ids: [] }],
      remaining: {},
      encounters: [],
    });
    const query = vi.fn(async (_m: string, d: any) => answer(d));
    const reg = new ForkRegistry(logger);
    registerPromptMarkers(reg, { query } as any, logger);
    const args = { action: 'replace', specFile: file, dryRun: true };
    const viaRegistry = await reg.dispatch('prompt-markers', args);
    const direct = await createPromptMarkersHandler({ foundryClient: { query } as any, logger })(
      args
    );
    expect(viaRegistry).toEqual(direct);
    const month = new Date().toISOString().slice(0, 7);
    const lines = readFileSync(join(dir, `mcp-${month}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line.args.specFile).toBe(file);
    expect(line.args.call).toBe('pm-9');
    expect(line.args.replacements[0].id).toBe('p4');
    expect(line.args.dryRun).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a specFile replace logs what the file held when it ran, even if it changes mid-call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-log16c-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    const file = join(dir, 'spec.json');
    const none = (id: string) => ({ id, with: { kind: 'none', reason: 'cut' } });
    writeFileSync(file, JSON.stringify({ call: 'pm-9', replacements: [none('p4')] }));
    const query = vi.fn(async (_m: string, d: any) => {
      writeFileSync(file, JSON.stringify({ call: 'pm-9', replacements: [none('p9')] }));
      return {
        dryRun: !!d.dryRun,
        call: d.call,
        text: `replace ${d.call} — dry run: 1 ok, 0 failed`,
        results: [
          { index: 0, id: 'p4', label: 'p4', kind: 'none', ok: true, created: [], ids: [] },
        ],
        remaining: {},
        encounters: [],
      };
    });
    const reg = new ForkRegistry(logger);
    registerPromptMarkers(reg, { query } as any, logger);
    await reg.dispatch('prompt-markers', { action: 'replace', specFile: file, dryRun: true });
    const month = new Date().toISOString().slice(0, 7);
    const line = JSON.parse(readFileSync(join(dir, `mcp-${month}.jsonl`), 'utf8').trim());
    expect(line.args.replacements[0].id).toBe('p4');
    expect(line.args.specFile).toBe(file);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unreadable specFile is still logged with the raw args', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-log16b-'));
    process.env.PENTARYN_MCP_LOG_DIR = dir;
    const reg = new ForkRegistry(logger);
    registerPromptMarkers(reg, { query: vi.fn() } as any, logger);
    const args = { action: 'replace', specFile: join(dir, 'missing.json'), dryRun: true };
    await expect(reg.dispatch('prompt-markers', args)).rejects.toThrow(/BAD_SPEC/);
    const month = new Date().toISOString().slice(0, 7);
    const line = JSON.parse(readFileSync(join(dir, `mcp-${month}.jsonl`), 'utf8').trim());
    expect(line).toMatchObject({ ok: false, args });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('toMcpPayload', () => {
  it('keeps upstream behaviour for plain results', () => {
    expect(toMcpPayload('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(toMcpPayload({ a: 1 })).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
  });

  it('refuses malformed blocks rather than passing them on', () => {
    const bad = { __mcpContent: [{ type: 'image', data: 'x' }] };
    expect(toMcpPayload(bad).content[0].type).toBe('text');
    expect(toMcpPayload({ __mcpContent: [] }).content[0]).toEqual({
      type: 'text',
      text: '{"__mcpContent":[]}',
    });
  });
});
