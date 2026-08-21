import { loadBusinessRuntimeConfig } from './config.js';
import { startBusinessRuntime } from './runtime.js';

const runtime = await startBusinessRuntime(loadBusinessRuntimeConfig());
runtime.app.log.info({ address: runtime.address }, 'business API listening');

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.app.log.info({ signal }, 'business API shutting down');
    void runtime
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        runtime.app.log.error({ error, signal }, 'business API shutdown failed');
        process.exitCode = 1;
      });
  });
}
