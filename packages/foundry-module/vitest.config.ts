import { defineConfig } from 'vitest/config';

// Node-only unit tests for the fork's browser-side code (src/fork/**). Foundry globals
// (game, CONFIG, window) are stubbed per test file; nothing here loads Foundry.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
