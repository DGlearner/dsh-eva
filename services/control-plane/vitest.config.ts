import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@company/observability': fileURLToPath(
        new URL('../../packages/observability/src/index.ts', import.meta.url),
      ),
      '@company/dsh-runner': fileURLToPath(
        new URL('../../runtimes/dsh-runner/src/index.ts', import.meta.url),
      ),
      '@company/dsh-extension': fileURLToPath(
        new URL('../../extensions/company-dsh/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { environment: 'node', passWithNoTests: true },
});
