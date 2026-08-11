/**
 * place-tokens — put tokens for EXISTING world actors onto a scene.
 *
 * Upstream can only create tokens as a side effect of creating an actor from a
 * compendium (`create-actor-from-compendium` with `addToScene`). Actors that
 * already exist — e.g. imported from a repo pipeline — cannot be placed at all.
 *
 * The module-side handler already exists and is already registered
 * (`queries.ts` -> `addActorsToScene`); it was simply never exposed as a tool.
 * So this file is the whole feature.
 */

import { z } from 'zod';
import type { FoundryClient } from '../../foundry-client.js';
import type { Logger } from '../../logger.js';
import type { ForkRegistry } from '../registry.js';

const ArgsSchema = z.object({
  actorNames: z.array(z.string()).min(1).max(50),
  placement: z.enum(['random', 'grid', 'center']).default('random'),
  hidden: z.boolean().default(false),
});

const DEFINITION = {
  name: 'place-tokens',
  description:
    'Place tokens for actors that already exist in the world onto the currently active scene. ' +
    'Use this for actors imported by a pipeline or created earlier — unlike ' +
    'create-actor-from-compendium, it does not create the actor. Returns the ids and ' +
    'coordinates of the tokens actually created. Requires a GM to be connected in Foundry; ' +
    'if the bridge is down the call fails cleanly and should be reported, not retried.',
  inputSchema: {
    type: 'object',
    properties: {
      actorNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Names of existing world actors to place (exact match preferred, substring fallback).',
      },
      placement: {
        type: 'string',
        enum: ['random', 'grid', 'center'],
        description: 'How to arrange the tokens on the scene. Default: random.',
      },
      hidden: {
        type: 'boolean',
        description: 'Create the tokens hidden from players. Default: false.',
      },
    },
    required: ['actorNames'],
  },
};

export function registerPlaceTokens(
  registry: ForkRegistry,
  foundryClient: FoundryClient,
  logger: Logger
): void {
  const log = logger.child({ component: 'place-tokens' });

  registry.register(
    DEFINITION,
    async (rawArgs: unknown) => {
      const args = ArgsSchema.parse(rawArgs);

      // Resolve names -> ids first, so a typo fails before anything is written
      // and the error names the actor rather than an opaque id.
      const actors = await foundryClient.query('foundry-mcp-bridge.listActors', {});
      const all: Array<{ id: string; name: string }> = actors?.actors ?? actors ?? [];

      const resolved: Array<{ id: string; name: string }> = [];
      const missing: string[] = [];
      for (const wanted of args.actorNames) {
        const hit =
          all.find(a => a.name?.toLowerCase() === wanted.toLowerCase()) ??
          all.find(a => a.name?.toLowerCase().includes(wanted.toLowerCase()));
        if (hit) resolved.push({ id: hit.id, name: hit.name });
        else missing.push(wanted);
      }

      if (missing.length) {
        throw new Error(
          `No world actor matches: ${missing.join(', ')}. ` +
            `Place only actors that already exist — use list-characters to see them.`
        );
      }

      log.info(`placing ${resolved.length} token(s), placement=${args.placement}`);

      const result = await foundryClient.query('foundry-mcp-bridge.addActorsToScene', {
        actorIds: resolved.map(r => r.id),
        placement: args.placement,
        hidden: args.hidden,
      });

      // Readback in the contract: report what actually landed, and fail loudly on
      // a count mismatch rather than reporting a cheerful success.
      const created = result?.tokensCreated ?? result?.created ?? result?.tokens ?? [];
      const createdCount = Array.isArray(created) ? created.length : Number(created) || 0;

      if (createdCount !== resolved.length) {
        throw new Error(
          `Token count mismatch: asked for ${resolved.length} ` +
            `(${resolved.map(r => r.name).join(', ')}) but Foundry created ${createdCount}. ` +
            `Nothing has been rolled back — inspect the scene before retrying.`
        );
      }

      // The upstream handler returns tokenIds in its own order, which does NOT
      // correspond to the order actors were passed in. Correlating by index would
      // silently mis-attribute tokens, so re-read the scene and match on actorId —
      // that is also the only way to report where anything actually landed.
      const newTokenIds: string[] = result?.tokenIds ?? [];
      let placed = resolved.map(r => ({
        actorId: r.id,
        name: r.name,
        tokenId: null as string | null,
        x: null as number | null,
        y: null as number | null,
      }));

      try {
        const scene = await foundryClient.query('foundry-mcp-bridge.getActiveScene', {});
        const tokens: any[] = scene?.tokens ?? [];
        placed = resolved.map(r => {
          const tok = tokens.find(
            t =>
              (t.actorId ?? t.actor?.id) === r.id &&
              (!newTokenIds.length || newTokenIds.includes(t.id ?? t._id))
          );
          return {
            actorId: r.id,
            name: r.name,
            tokenId: tok?.id ?? tok?._id ?? null,
            x: tok?.x ?? null,
            y: tok?.y ?? null,
          };
        });
      } catch (err) {
        log.warn(`placed tokens but could not read the scene back to correlate ids: ${err}`);
      }

      const uncorrelated = placed.filter(p => !p.tokenId).map(p => p.name);

      return {
        ok: true,
        summary:
          `placed ${createdCount} token(s) on the active scene ` +
          `[${placed.map(p => `${p.name}${p.x !== null ? ` @${p.x},${p.y}` : ''}`).join(', ')}]` +
          `${args.hidden ? ' (hidden)' : ''}`,
        ids: {
          tokens: placed.map(p => p.tokenId).filter(Boolean),
          actors: resolved.map(r => r.id),
        },
        placed,
        warnings: uncorrelated.length
          ? [`Could not correlate token ids for: ${uncorrelated.join(', ')} — re-query the scene.`]
          : undefined,
      };
    },
    { write: true }
  );
}
