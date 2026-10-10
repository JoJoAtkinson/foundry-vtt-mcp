/**
 * fork: per-query transport timeout. The connector used a flat 10 s, which silently
 * capped eval-js's 60 s and the prompt-markers gather.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket from 'ws';
import { FoundryConnector } from './foundry-connector.js';

const logger: any = { info() {}, debug() {}, warn() {}, error() {}, child: () => logger };

function connected() {
  const c = new FoundryConnector({ config: { port: 0 } as any, logger });
  const sent: any[] = [];
  (c as any).activeConnectionType = 'websocket';
  (c as any).foundrySocket = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(m) };
  return { c, sent };
}

afterEach(() => vi.useRealTimers());

describe('FoundryConnector.query timeout', () => {
  it('defaults to 10 s', async () => {
    vi.useFakeTimers();
    const { c } = connected();
    const p = c.query('x.y', {});
    const caught = p.catch(e => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect((c as any).pendingQueries.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await caught)).toMatch(/Query timeout: x\.y \(10000 ms\)/);
  });

  it('honours timeoutMs and clamps it to 1-120 s', async () => {
    vi.useFakeTimers();
    const { c } = connected();
    const long = c.query('a.b', {}, { timeoutMs: 60_000 }).catch(e => e);
    const huge = c.query('a.c', {}, { timeoutMs: 10_000_000 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(59_999);
    expect((c as any).pendingQueries.size).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await long)).toMatch(/60000 ms/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(await huge)).toMatch(/120000 ms/);
  });
});
