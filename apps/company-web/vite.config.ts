import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { liveApiProxyTarget } from './proxy-target';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = liveApiProxyTarget(env);

  return {
    plugins: [react()],
    server: {
      port: 4173,
      proxy: proxyTarget
        ? {
            '/company-api/v1': {
              target: proxyTarget,
              changeOrigin: true,
            },
          }
        : undefined,
    },
    preview: { port: 4173 },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
  };
});
