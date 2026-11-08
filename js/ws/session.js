/**
 * Builds a workspace from the bundled list: seeds the synthetic history, then replays the ops the
 * visitor saved. Used by the page and by the tests.
 */
import { buildVersions } from './lists.js';
import { Workspace } from './engine.js';
import { seedWorkspace } from './seed.js';
import { SCHEMA } from './persist.js';

/**
 * Args: list, the parsed OFAC bundle; anchor, the Date the demo began; savedOps, ops from an
 *   earlier visit to replay after the history; seed, for the synthetic data.
 * Returns: { ws, held, replayError } where replayError is a message when saved ops could not be
 *   replayed (the workspace then holds only the seeded history).
 * `network` (optional) is the DemoNetwork whose members take part in the seeded network history;
 * without it the workspace has no receipt-network history.
 */
export async function createWorkspace({ list, anchor, savedOps = [], seed, network = null }) {
  const built = await buildVersions(list);
  const make = async () => {
    const ws = new Workspace({ versions: built.versions });
    await seedWorkspace(ws, { anchor, held: built, seed, network });
    return ws;
  };
  let ws = await make();
  let replayError = null;
  try {
    for (const op of savedOps) await ws.apply(op);
  } catch (error) {
    replayError = error?.message ?? 'Saved state could not be restored.';
    ws = await make();
  }
  return { ws, held: built, replayError };
}

/** The part of the state worth saving: only what the visitor did after the seeded history. */
export function snapshot(ws, anchor) {
  return { schema: SCHEMA, anchor: anchor.toISOString(), ops: ws.ops.slice(ws.seedCount) };
}
