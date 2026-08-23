/**
 * Fork entry point. Everything the fork adds is constructed here, so upstream's
 * backend.ts needs exactly two one-line hunks: spread the definitions into
 * allTools, and try the registry in the switch's default case.
 */

import type { FoundryClient } from '../foundry-client.js';
import type { Logger } from '../logger.js';
import { ForkRegistry } from './registry.js';
import { registerEvalJs } from './tools/eval-js.js';

export { ForkRegistry } from './registry.js';

export function createForkRegistry(foundryClient: FoundryClient, logger: Logger): ForkRegistry {
  const registry = new ForkRegistry(logger);

  registerEvalJs(registry, foundryClient, logger);

  logger.info(`fork registry: ${registry.getToolDefinitions().length} tool(s)`);
  return registry;
}
