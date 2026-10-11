/**
 * Tell a running MCP session when the backend's tool list changes.
 *
 * Each Claude session runs its own wrapper (index.ts) in front of one shared backend.
 * A backend respawned from a rebuilt dist/ can serve new or changed tools, but a session
 * keeps the list it fetched at startup unless the server sends `tools/list_changed`. The
 * wrapper therefore announces `listChanged: true`, remembers what it last served
 * (`markServed`), and polls the backend every 30 s (a local socket round trip).
 */

import { createHash } from 'crypto';

/**
 * Fingerprint of a tool list, compared between polls: a sha1 of every tool's name,
 * description and inputSchema, sorted by name — so a new schema property or a reworded
 * description of the same length is a change too.
 */
export function toolsKey(tools: any[] | undefined | null): string {
  const triples = (tools ?? [])
    .map(t => [t?.name, t?.description ?? '', t?.inputSchema ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha1').update(JSON.stringify(triples)).digest('hex');
}

/**
 * Start the poll. Nothing is compared until the session has fetched the list once
 * (`markServed`), a failed poll (backend restarting) is retried on the next tick, and
 * the timer never keeps the process alive.
 *
 * @returns markServed — call it with the tools the ListTools handler just returned.
 */
export function watchToolList(
  mcp: { sendToolListChanged(): Promise<void> },
  send: () => Promise<{ tools?: any[] } | undefined>,
  intervalMs = 30_000,
  log: (msg: string) => void = () => {}
): (tools: any[]) => void {
  let served: string | null = null;
  const poll = setInterval(async () => {
    if (served === null) return;
    try {
      const res = await send();
      const tools = res?.tools || [];
      const key = toolsKey(tools);
      // An empty list is a backend still starting, not a change.
      if (tools.length && key !== served) {
        served = key;
        await mcp.sendToolListChanged();
        log('tools/list changed; notified the client');
      }
    } catch {
      /* backend restarting: try again next tick */
    }
  }, intervalMs);
  (poll as any).unref?.();
  return tools => {
    served = toolsKey(tools);
  };
}
