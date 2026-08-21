import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@company/dsh-extension': fileURLToPath(
        new URL('../../extensions/company-dsh/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { environment: 'node', passWithNoTests: true },
});
