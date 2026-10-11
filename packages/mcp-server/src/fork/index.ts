/**
 * Fork entry point. Everything the fork adds is constructed here, which keeps the
 * upstream edits to small marked hunks (grep "fork:"); the full list, with line
 * ranges and which ones are upstream PR candidates, is FORK.md at the repo root.
 */

import type { FoundryClient } from '../foundry-client.js';
import type { Logger } from '../logger.js';
import { ActionLog } from './action-log.js';
import { ForkRegistry } from './registry.js';
import { registerEvalJs } from './tools/eval-js.js';
import { registerPentarynRead } from './tools/pentaryn-read.js';
import { registerPentarynWrite } from './tools/pentaryn-write.js';
import { registerPromptMarkers } from './tools/prompt-markers.js';

export { ForkRegistry } from './registry.js';

export function createForkRegistry(foundryClient: FoundryClient, logger: Logger): ForkRegistry {
  const actionLog = ActionLog.fromEnv(logger);
  const registry = new ForkRegistry(logger, actionLog);

  registerEvalJs(registry, foundryClient, logger, actionLog);
  registerPromptMarkers(registry, foundryClient, logger);
  registerPentarynRead(registry, foundryClient, logger);
  registerPentarynWrite(registry, foundryClient, logger);

  logger.info(`fork registry: ${registry.getToolDefinitions().length} tool(s)`);
  return registry;
}
