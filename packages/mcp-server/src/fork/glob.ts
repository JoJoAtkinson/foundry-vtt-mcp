/**
 * Convert a deny-glob ("dnd5e-*", "generate-map") to a matcher. Only `*` is
 * supported — anything richer invites a regex-injection footgun for no gain.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}
