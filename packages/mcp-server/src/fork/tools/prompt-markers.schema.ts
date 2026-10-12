/**
 * prompt-markers argument schemas (mcp-fork-14): the zod copy of what the pentaryn-prompts
 * module accepts, per action, and parseArgs(). The module re-checks every field; these
 * exist so a bad call fails before the round trip, with a `BAD_SPEC:` line per issue.
 * prompt-markers.ts re-exports parseArgs and ReplacementT.
 */

import { z } from 'zod';

const Id = z.string().min(1);
const PromptId = z.string().regex(/^p\d+$/, 'expected a prompt id like "p3"');
const EncounterId = z.string().regex(/^E\d+$/, 'expected an encounter id like "E1"');

/** Creature sizes: the npc's `size` and a patch's `size` (one list; it was two). */
const SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
const FEATURE_TYPES = [
  'passive',
  'save',
  'attack',
  'attack-with-save',
  'aura',
  'spellcasting',
  'spells',
] as const;

const Disposition = z.enum(['hostile', 'neutral', 'friendly', 'secret']);

const ItemRef = z
  .object({
    uuid: Id.optional(),
    name: Id.optional(),
    quantity: z.number().int().min(1).optional(),
    equipped: z.boolean().optional(),
    rename: Id.optional(),
    system: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(i => !!(i.uuid || i.name), { message: 'item needs uuid or name' });

/** An item built inline: `{data}` (an Item's source) and an optional quantity. */
const InlineItem = z
  .object({ data: z.record(z.unknown()), quantity: z.number().int().min(1).optional() })
  .strict();

/** A compendium/world item by {uuid | name}, or one built inline. */
const ItemSpec = z.union([ItemRef, InlineItem]);

const Trait = z
  .object({
    name: Id,
    html: z.string().optional(),
    activation: z
      .enum(['passive', 'action', 'bonus', 'reaction', 'special', 'minute', 'hour'])
      .optional(),
    recharge: z.number().int().min(2).max(6).optional(),
    uses: z
      .object({ max: z.number().int().min(1), per: z.enum(['day', 'lr', 'sr', 'dawn']).optional() })
      .strict()
      .optional(),
    img: Id.optional(),
  })
  .strict();

/** "Stock monster plus changes" — applied by the module before the token is placed. */
const Patch = z
  .object({
    name: Id.optional(),
    size: z.enum(SIZES).optional(),
    img: Id.optional(),
    biography: z.string().optional(),
    hp: z
      .union([
        z.number().int().min(1),
        z.object({ max: z.number().int().min(1), formula: z.string().optional() }).strict(),
      ])
      .optional(),
    ac: z.number().int().min(1).max(40).optional(),
    /** A number, or a fraction / number as text ("1/2", "3") — the module reads fractions (parseCr). */
    cr: z
      .union([
        z.number().min(0).max(30),
        z
          .string()
          .regex(/^\s*(\d+(\.\d+)?|\d+\s*\/\s*[1-9]\d*)\s*$/, 'cr like 3, 0.5 or "1/2"')
          .refine(
            v => {
              const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v);
              const n = m ? Number(m[1]) / Number(m[2]) : Number(v);
              return n >= 0 && n <= 30;
            },
            { message: 'cr must be 0 to 30' }
          ),
      ])
      .optional(),
    speed: z.number().int().min(0).optional(),
    disposition: Disposition.optional(),
    removeItems: z.array(Id).optional(),
    addItems: z.array(ItemSpec).optional(),
    traits: z.array(Trait).optional(),
    recharge: z.record(z.number().int().min(2).max(6)).optional(),
    itemUpdates: z.array(z.object({ item: Id, set: z.record(z.unknown()) }).strict()).optional(),
    set: z.record(z.unknown()).optional(),
    /** "construct" or "humanoid (goblinoid)"; a type change without `languages` clears inherited ones. */
    creatureType: Id.optional(),
    /** Replaces the actor's languages; names or dnd5e keys ([] for none). */
    languages: z.array(z.string()).optional(),
  })
  .strict();

const WithActor = z
  .object({
    kind: z.literal('actor'),
    actorId: Id.optional(),
    uuid: Id.optional(),
    copy: z.boolean().optional(),
    patch: Patch.optional(),
  })
  .strict();

const StartingOption = z.enum(['A', 'B', 'a', 'b', 'none']);

/** An AmbientLight config placed with a hotspot or note (the module checks the keys against LightData). */
const LightConfig = z.record(z.unknown());

/** A level-N player character from the owned books, advanced by dnd5e's own advancements. */
const WithCharacter = z
  .object({
    kind: z.literal('character'),
    name: Id,
    level: z.number().int().min(1).max(20),
    class: Id,
    subclass: Id.optional(),
    species: Id,
    background: Id,
    abilities: z.record(z.number().int()),
    abilityMethod: z.enum(['array', 'pointbuy', 'manual']).optional(),
    choices: z.record(z.unknown()).optional(),
    hp: z.enum(['avg', 'max']).optional(),
    size: z.enum(['small', 'medium']).optional(),
    spells: z.array(Id).optional(),
    spellbook: z.array(Id).optional(),
    allowOffList: z.boolean().optional(),
    items: z.array(z.union([Id, ItemRef, InlineItem])).optional(),
    biography: z.string().optional(),
    alignment: z.string().optional(),
    img: Id.optional(),
    /** The Actor folder (an id or a name; found, or created) — default Foundry MCP Characters. */
    folder: Id.optional(),
    /**
     * The class's and background's PHB starting equipment: "A" (the gear, packs packed, a holy
     * symbol / arcane focus picked and printed as DEFAULTED unless one is in `items`), "B" (the
     * gold instead), "none" (default), or {class, background} separately.
     */
    startingEquipment: z
      .union([
        z.boolean(),
        StartingOption,
        z
          .object({ class: StartingOption.optional(), background: StartingOption.optional() })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const WithNpc = z
  .object({
    kind: z.literal('npc'),
    // Full dnd5e-create-npc arguments; every field checked (and defaulted as that tool does) by the
    // module, which names the bad field and refuses unknown keys, in the dry run as well.
    npc: z.object({ name: Id, size: z.enum(SIZES) }).passthrough(),
    // dnd5e-add-feature arguments minus actorIdentifier (filled in with the new actor by the module).
    features: z
      .array(
        z
          .object({
            featureType: z.enum(FEATURE_TYPES),
            // Recharge n-6; applied by the module after the feature exists (dnd5e-add-feature has it too).
            recharge: z.number().int().min(2).max(6).optional(),
          })
          .passthrough()
      )
      .max(40)
      .optional(),
    patch: Patch.optional(),
  })
  .strict();

const WithHotspot = z
  .object({
    kind: z.literal('hotspot'),
    name: Id,
    description: z.string(),
    // {uuid | name} from a compendium, or {data} built inline — never via manage-world-items.
    items: z.array(ItemSpec).optional(),
    size: z.number().positive().max(4).optional(),
    locked: z.boolean().optional(),
    icon: Id.optional(),
    /** A glow at the hotspot's centre: AmbientLight config ({dim, bright, color, animation}). */
    light: LightConfig.optional(),
  })
  .strict();

const WithNote = z
  .object({
    kind: z.literal('note'),
    name: Id,
    html: z.string(),
    folderId: Id.optional(),
    label: z.string().optional(),
    ownership: z
      .union([z.enum(['observer', 'none']), z.record(z.number().int().min(-1).max(3))])
      .optional(),
    iconSize: z.number().int().min(8).max(512).optional(),
    icon: Id.optional(),
    /** A light at the pin: AmbientLight config. */
    light: LightConfig.optional(),
  })
  .strict();

const WithLight = z
  .object({
    kind: z.literal('light'),
    config: z.record(z.unknown()),
    hidden: z.boolean().optional(),
  })
  .strict();

const WithTile = z
  .object({
    kind: z.literal('tile'),
    src: Id,
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  })
  .strict();

const WithNone = z.object({ kind: z.literal('none'), reason: Id }).strict();

const With = z.discriminatedUnion('kind', [
  WithActor,
  WithNpc,
  WithCharacter,
  WithHotspot,
  WithNote,
  WithLight,
  WithTile,
  WithNone,
]);

const Replacement = z
  .object({
    call: Id.optional(),
    id: PromptId.optional(),
    sceneId: Id.optional(),
    markerId: Id.optional(),
    with: With,
    name: z.string().optional(),
    hidden: z.boolean().optional(),
    note: z.string().optional(),
    /** Token ring tier (README token conventions); characters default to pc. */
    ring: z.enum(['pc', 'foe', 'named', 'mook', 'none']).optional(),
    img: Id.optional(),
    disposition: Disposition.optional(),
  })
  .strict();

export type ReplacementT = z.infer<typeof Replacement>;

/** "4x5" (size x level), {size, level}, or a list of levels. */
const Party = z.union([
  z.string().regex(/^\s*\d+\s*[x×*]\s*\d+\s*$/i, 'party like "4x5" (size x level)'),
  z
    .object({ size: z.number().int().min(1).max(12), level: z.number().int().min(1).max(20) })
    .strict(),
  z.array(z.number().int().min(1).max(20)).min(1).max(12),
]);

const SceneSelection = z.union([
  z.literal('all'),
  z.literal('current'),
  z.array(Id).min(1),
  // A single scene id/name is accepted and wrapped.
  Id.transform(s => [s]),
]);

const ListArgs = z.object({ action: z.literal('list') }).strict();

const GatherArgs = z
  .object({
    action: z.literal('gather'),
    scenes: SceneSelection.optional(),
    crops: z.union([z.literal('auto'), z.boolean()]).optional(),
    chars: z.number().int().min(20).max(2000).optional(),
    unseenWithinFt: z.number().int().min(0).max(1000).optional(),
    builtWithoutProvenance: z.boolean().optional(),
    maxPrompts: z.number().int().min(1).max(200).optional(),
    party: Party.optional(),
  })
  .strict();

const CropsArgs = z
  .object({
    action: z.literal('crops'),
    call: Id,
    encounters: z.array(EncounterId).min(1).max(6),
  })
  .strict();

const ReplaceArgs = z
  .object({
    action: z.literal('replace'),
    call: Id.optional(),
    replacements: z.array(Replacement).min(1).max(100),
    /** Set when the replacements came from a spec file (the handler reads it before parsing). */
    specFile: z.string().optional(),
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
    party: Party.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    a.replacements.forEach((r, i) => {
      const call = r.call ?? a.call;
      const byId = !!r.id;
      const byDoc = !!(r.sceneId && r.markerId);
      if (!byId && !byDoc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replacements', i],
          message: 'target needs id (with a call) or sceneId + markerId',
        });
        return;
      }
      if (byId && !call && !byDoc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replacements', i, 'id'],
          message: `"${r.id}" needs the gather's call id (top-level call or per replacement)`,
        });
      }
      if (r.with.kind === 'actor' && !!r.with.actorId === !!r.with.uuid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replacements', i, 'with'],
          message: 'actor needs exactly one of actorId or uuid',
        });
      }
      const key = byDoc ? `${r.sceneId}/${r.markerId}` : `${call}/${r.id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['replacements', i],
          message: `the same marker is replaced twice (${key})`,
        });
      }
      seen.add(key);
    });
  });

const ShowArgs = z
  .object({
    action: z.literal('show'),
    call: Id.optional(),
    id: PromptId.optional(),
    sceneId: Id.optional(),
    markerId: Id.optional(),
  })
  .strict()
  .refine(a => (a.call && a.id) || (a.sceneId && a.markerId), {
    message: 'show needs call + id, or sceneId + markerId',
  });

export const ACTIONS = ['list', 'gather', 'crops', 'replace', 'show'] as const;
export type Action = (typeof ACTIONS)[number];

const SCHEMAS: Record<Action, z.ZodTypeAny> = {
  list: ListArgs,
  gather: GatherArgs,
  crops: CropsArgs,
  replace: ReplaceArgs,
  show: ShowArgs,
};

/** zod error → one `BAD_SPEC:` line per issue, paths in the caller's own terms. */
function badSpec(err: z.ZodError): Error {
  const lines = err.issues.map(i => {
    const path = i.path.length ? i.path.join('.') : '(args)';
    return `${path}: ${i.message}`;
  });
  return new Error(`BAD_SPEC: ${lines.join('; ')}`);
}

export function parseArgs(raw: unknown): { action: Action; args: any } {
  const action = (raw as any)?.action;
  if (!ACTIONS.includes(action)) {
    throw new Error(`BAD_SPEC: action must be one of ${ACTIONS.join(' | ')}`);
  }
  const res = SCHEMAS[action as Action].safeParse(raw);
  if (!res.success) throw badSpec(res.error);
  return { action, args: res.data };
}
