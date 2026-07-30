import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@noir-adapter/core': `${root}packages/core/src/index.ts`,
      '@noir-adapter/noir-wallet': `${root}packages/wallets/noir-wallet/src/index.ts`,
      '@noir-adapter/react': `${root}packages/react/src/index.ts`,
      '@noir-adapter/ui': `${root}packages/ui/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
});
