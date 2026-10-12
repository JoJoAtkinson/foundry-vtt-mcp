/**
 * The eval result serializer (mcp-fork-9), moved verbatim from handlers.ts with its
 * limits named. The unreachable Set branch is gone: a Set has entries() and a numeric
 * size, so the collection branch always took it (serialize.test.ts proves the output).
 */

/** Caps applied by serialize(); the eval-js description quotes them. */
export const SERIALIZE_LIMITS = Object.freeze({ depth: 4, array: 200, collection: 100 });

/**
 * Serialize an arbitrary evaluation result for transport back over the bridge.
 *
 * Foundry documents are cyclic and enormous; naive JSON.stringify either throws
 * or ships megabytes. Documents collapse to a useful identity, collections to
 * their contents, and depth is capped. The rules (pinned in serialize.test.ts and
 * stated in the eval-js tool description, which must change with them):
 *
 *  - null/undefined → null; strings, numbers, booleans as is (strings unbounded);
 *    functions → "[Function name]"; bigint and symbol → their string.
 *  - deeper than SERIALIZE_LIMITS.depth → "[max depth]".
 *  - any object seen before in this result → "[circular]" (a repeated reference too,
 *    not only a true cycle).
 *  - Date → ISO string; an invalid Date (getTime() is NaN) → "[unserializable]" wherever
 *    it appears (top level, array element, collection value, object property) (rob-2);
 *    Error → {error, stack (4 lines)}.
 *  - a Foundry Document (documentName + _id) → {_document, _id, name}, plus `source`
 *    (toObject()) only at depth 0.
 *  - Map, Set, Foundry Collection (anything with entries() and a numeric size) → array
 *    of its values, at most SERIALIZE_LIMITS.collection, then "[+N more]".
 *  - arrays → at most SERIALIZE_LIMITS.array items, then "[+N more]".
 *  - other objects → own enumerable keys, dropping `_`-keys except `_id`; a throwing
 *    getter → "[unserializable]".
 */
export function serialize(value: any, depth = 0, seen = new WeakSet()): any {
  if (value === null || value === undefined) return value ?? null;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (t === 'bigint') return value.toString();
  if (t === 'symbol') return value.toString();

  if (depth > SERIALIZE_LIMITS.depth) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? '[unserializable]' : value.toISOString();
  if (value instanceof Error)
    return { error: value.message, stack: value.stack?.split('\n').slice(0, 4) };

  // Foundry Documents — identity plus source data, not the whole live object.
  if (value.documentName && value._id !== undefined) {
    return {
      _document: value.documentName,
      _id: value._id,
      name: value.name ?? undefined,
      ...(depth === 0 ? { source: safeToObject(value) } : {}),
    };
  }

  // Collections (Map, Set, Foundry's Collection) — Foundry uses these heavily.
  if (
    value instanceof Map ||
    (typeof value.entries === 'function' && typeof value.size === 'number')
  ) {
    const out: any[] = [];
    let n = 0;
    for (const v of value.values()) {
      if (n++ >= SERIALIZE_LIMITS.collection) {
        out.push(`[+${value.size - SERIALIZE_LIMITS.collection} more]`);
        break;
      }
      out.push(serialize(v, depth + 1, seen));
    }
    return out;
  }

  if (Array.isArray(value)) {
    if (value.length > SERIALIZE_LIMITS.array) {
      return [
        ...value.slice(0, SERIALIZE_LIMITS.array).map(v => serialize(v, depth + 1, seen)),
        `[+${value.length - SERIALIZE_LIMITS.array} more]`,
      ];
    }
    return value.map(v => serialize(v, depth + 1, seen));
  }

  const out: Record<string, any> = {};
  for (const k of Object.keys(value)) {
    if (k.startsWith('_') && k !== '_id') continue;
    try {
      out[k] = serialize(value[k], depth + 1, seen);
    } catch {
      out[k] = '[unserializable]';
    }
  }
  return out;
}

function safeToObject(doc: any): any {
  try {
    return doc.toObject ? doc.toObject() : undefined;
  } catch {
    return undefined;
  }
}
