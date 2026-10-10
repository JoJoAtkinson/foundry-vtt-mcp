/**
 * MCP result payloads.
 *
 * Upstream's backend wraps every tool result in exactly one text block
 * (`JSON.stringify(result)`), so a tool cannot return an image. A fork tool that
 * needs more returns `{ __mcpContent: [...blocks] }` and the backend passes those
 * blocks through untouched. Everything else keeps upstream's behaviour exactly.
 */

export type McpTextBlock = { type: 'text'; text: string };
export type McpImageBlock = { type: 'image'; data: string; mimeType: string };
export type McpContentBlock = McpTextBlock | McpImageBlock;

export interface McpPayload {
  content: McpContentBlock[];
  isError?: boolean;
}

function isContentBlock(b: unknown): b is McpContentBlock {
  if (!b || typeof b !== 'object') return false;
  const t = (b as any).type;
  if (t === 'text') return typeof (b as any).text === 'string';
  if (t === 'image')
    return typeof (b as any).data === 'string' && typeof (b as any).mimeType === 'string';
  return false;
}

/** The backend's one hunk calls this in place of building the text block itself. */
export function toMcpPayload(result: unknown): McpPayload {
  const blocks = (result as any)?.__mcpContent;
  if (Array.isArray(blocks) && blocks.length > 0 && blocks.every(isContentBlock)) {
    return { content: blocks };
  }
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result),
      },
    ],
  };
}
