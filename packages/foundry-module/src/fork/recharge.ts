/**
 * Recharge n–6 on a dnd5e feature (mcp-fork-10): one use, regained on a d6 roll of n+,
 * consumed by every activity of the feature (an activity's itemUses target naming another
 * item is kept; fork-edge-5). dnd5e-add-feature's `recharge` argument
 * applies it through the `foundry-mcp-bridge.fork.applyRecharge` query (handlers.ts).
 * Pure: builds the update row, writes nothing.
 */

/** The `updateEmbeddedDocuments('Item', [row])` row that gives `item` Recharge n–6. */
export function rechargeUpdate(item: any, n: number): Record<string, unknown> {
  const row: Record<string, unknown> = {
    _id: item.id,
    'system.uses': {
      max: '1',
      spent: 0,
      recovery: [{ period: 'recharge', formula: String(n), type: 'recoverAll' }],
    },
  };
  for (const a of item.system?.activities ?? []) {
    const keep = (a.consumption?.targets ?? [])
      // Only the feature's own itemUses target ('' or its id) is replaced; one naming another item stays.
      .filter((t: any) => !(t.type === 'itemUses' && (!t.target || t.target === item.id)))
      .map((t: any) => t.toObject?.() ?? t);
    row[`system.activities.${a.id}.consumption.targets`] = [
      ...keep,
      { type: 'itemUses', target: '', value: '1' },
    ];
  }
  return row;
}
