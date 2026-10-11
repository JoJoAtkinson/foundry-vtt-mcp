/**
 * Tell a running MCP session when the backend's tool list changes.
 *
 * Each Claude session runs its own wrapper (index.ts) in front of one shared backend.
 * A backend respawned from a rebuilt dist/ can serve new or changed tools, but a session
 * keeps the list it fetched at startup unless the server sends `tools/list_changed`. The
 * wrapper therefore announces `listChanged: true`, remembers what it last served
 * (`markServed`), and polls the backend every 30 s (a local socket round trip).
 */

/** Fingerprint of a tool list, compared between polls. */
export function toolsKey(tools: any[] | undefined | null): string {
  return (tools ?? [])
    .map(t => `${t?.name}:${String(t?.description ?? '').length}`)
    .sort()
    .join('|');
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
      const key = toolsKey(res?.tools || []);
      if (key && key !== served) {
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
