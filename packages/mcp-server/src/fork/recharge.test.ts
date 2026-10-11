import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DnD5eAddFeatureTool } from '../tools/dnd5e/add-feature.js';
import { ActionLog } from './action-log.js';
import { applyRecharge } from './recharge.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('applyRecharge through the typed fork query (mcp-fork-10)', () => {
  // Before this step recharge went through fork.eval with its own actor lookup (id, exact
  // name, substring) and no token-id fallback, and left no action-log line. The row it
  // wrote is now built by foundry-module's rechargeUpdate and pinned there, with the same
  // fixture and the token-id case (packages/foundry-module/src/fork/recharge.test.ts).
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const log = () => {
    const dir = mkdtempSync(join(tmpdir(), 'recharge-'));
    dirs.push(dir);
    return { dir, actionLog: new ActionLog(logger, dir) };
  };
  const lines = (dir: string) =>
    readdirSync(dir).flatMap(f =>
      readFileSync(join(dir, f), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    );
  const REQ = { actorIdentifier: 'Ogre', itemId: 'I1', featureName: 'Breath', n: 5 };

  it('sends the request to the applyRecharge query and returns the label', async () => {
    const query = vi.fn(async () => ({
      ok: true,
      label: 'Recharge 5–6',
      actorId: 'O1',
      itemId: 'I1',
    }));
    const { dir, actionLog } = log();
    expect(await applyRecharge({ query } as any, REQ, logger, actionLog)).toBe('Recharge 5–6');
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.fork.applyRecharge', REQ);
    expect(lines(dir)).toEqual([
      expect.objectContaining({
        tool: 'dnd5e-add-feature',
        action: 'recharge',
        args: REQ,
        ok: true,
        summary: 'Recharge 5–6',
      }),
    ]);
  });

  it('no label -> the generic text', async () => {
    const { actionLog } = log();
    expect(
      await applyRecharge({ query: async () => ({ ok: true }) } as any, REQ, logger, actionLog)
    ).toBe('Recharge 5–6');
  });

  it('the strings add-feature.ts printed before: not applied (<why>)', async () => {
    const { dir, actionLog } = log();
    const failing = { query: async () => ({ ok: false, error: 'x' }) };
    expect(await applyRecharge(failing as any, REQ, logger, actionLog)).toBe('not applied (x)');
    const throwing = {
      query: async () => {
        throw new Error('No handler found for query: foundry-mcp-bridge.fork.applyRecharge');
      },
    };
    expect(await applyRecharge(throwing as any, REQ, logger, actionLog)).toBe(
      'not applied (No handler found for query: foundry-mcp-bridge.fork.applyRecharge)'
    );
    expect(lines(dir).map(l => l.ok)).toEqual([false, false]);
  });

  it('add-feature no longer builds an eval script for recharge', () => {
    const tool = new DnD5eAddFeatureTool({ foundryClient: { query: vi.fn() } as any, logger });
    expect((tool as any).applyRecharge).toBeUndefined();
  });
});
