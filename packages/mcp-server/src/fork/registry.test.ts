import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ForkRegistry, type ForkToolHandler } from './registry.js';

const logger: any = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const DEF = (name: string) => ({ name, description: '', inputSchema: {} });

describe('tool contract types (mcp-fork-22)', () => {
  it('accepts the documented result shapes', async () => {
    const reg = new ForkRegistry(logger);
    const str: ForkToolHandler = async () => 'plain text';
    const obj: ForkToolHandler = async () => ({ summary: 's', ids: ['a'], extra: 1 });
    reg.register(DEF('s'), str, { write: false });
    reg.register(DEF('o'), obj, { write: a => !!a?.w });
    expect(await reg.dispatch('s', {})).toBe('plain text');
    expect(await reg.dispatch('o', {})).toEqual({ summary: 's', ids: ['a'], extra: 1 });
    // Type-level pin (checked by `tsc` on this file, not by vitest): ids must be string[].
    // @ts-expect-error ids is string[], not string
    const bad: ForkToolHandler = async () => ({ ids: 'x' });
    void bad;
  });
});
