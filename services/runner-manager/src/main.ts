import Docker from 'dockerode';
import { Redis } from 'ioredis';

import { createLogger } from '@company/observability';

import { buildRunnerManager } from './app.js';
import { DockerodeRunnerPort } from './docker-wrapper.js';
import { RedisLeaseStore } from './lease.js';
import { RunnerManager } from './manager.js';
import { PgRunnerRepository } from './pg-repository.js';
import { RunnerResourceTemplate } from './resource-template.js';

const logger = createLogger('runner-manager');
const repository = new PgRunnerRepository(required('DATABASE_URL'));
const redis = new Redis(required('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 2 });
await redis.connect();
const manager = new RunnerManager({
  repository,
  docker: new DockerodeRunnerPort(
    new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' }),
  ),
  leases: new RedisLeaseStore(redis),
  template: new RunnerResourceTemplate({
    image: required('RUNNER_IMAGE'),
    imageVersion: required('RUNNER_IMAGE_VERSION'),
    dataRoot: required('RUNNER_DATA_ROOT'),
    runnerIdentityRootSecret: Buffer.from(required('RUNNER_IDENTITY_SECRET_BASE64'), 'base64'),
    ingressNetworkName: process.env.RUNNER_INGRESS_NETWORK ?? 'company-runner',
    egressNetworkName: process.env.RUNNER_EGRESS_NETWORK ?? 'company-runner-egress',
    internalPort: numberEnv('RUNNER_INTERNAL_PORT', 3000),
  }),
});
await manager.reconcileAll();

const app = buildRunnerManager({ manager, serviceToken: required('INTERNAL_SERVICE_TOKEN') });
const address = await app.listen({
  host: process.env.RUNNER_MANAGER_HOST ?? '127.0.0.1',
  port: numberEnv('RUNNER_MANAGER_PORT', 8081),
});
logger.info({ address }, 'runner manager listening');

const timer = setInterval(
  () => {
    void manager
      .reconcileAll()
      .catch((error: unknown) => logger.error({ error }, 'runner reconcile failed'));
  },
  numberEnv('RUNNER_RECONCILE_INTERVAL_MS', 30_000),
);
timer.unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void app.close().finally(async () => {
      redis.disconnect();
      await repository.close();
      process.exit(0);
    });
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} is invalid`);
  return number;
}
