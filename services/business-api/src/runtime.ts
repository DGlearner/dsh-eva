import type { FastifyInstance } from 'fastify';

import { DisabledAutomationProvider } from './adapters/automation/disabled-automation-provider.js';
import { FakeAutomationProvider } from './adapters/automation/fake-automation-provider.js';
import { InternalAutomationClient } from './adapters/automation/internal-automation-client.js';
import { FakeBusinessRepository } from './adapters/fake/fake-business-repository.js';
import { PostgresBusinessRepository } from './adapters/postgres/postgres-business-repository.js';
import { buildBusinessApp } from './app.js';
import type { BusinessRuntimeConfig } from './config.js';
import type { AutomationPort } from './ports/automation.js';
import { SystemClock, type Clock } from './ports/clock.js';
import type { BusinessRepository } from './ports/repository.js';

export interface RuntimeBusinessRepository extends BusinessRepository {
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export interface BusinessRuntimeDependencies {
  clock?: Clock;
  logger?: boolean;
  createFakeRepository?: () => RuntimeBusinessRepository;
  createPostgresRepository?: (databaseUrl: string) => RuntimeBusinessRepository;
  createFakeAutomation?: (clock: Clock) => AutomationPort;
  createInternalAutomation?: (baseUrl: string, token: string) => AutomationPort;
}

export interface RunningBusinessRuntime {
  app: FastifyInstance;
  address: string;
  repository: RuntimeBusinessRepository;
  close(): Promise<void>;
}

export async function startBusinessRuntime(
  config: BusinessRuntimeConfig,
  dependencies: BusinessRuntimeDependencies = {},
): Promise<RunningBusinessRuntime> {
  const clock = dependencies.clock ?? new SystemClock();
  const repository = createRepository(config, dependencies);
  const automation = createAutomation(config, clock, dependencies);
  const app = buildBusinessApp({
    repository,
    automation,
    clock,
    actorTokenSecret: config.actorTokenSecret,
    actorTokenIssuer: config.actorTokenIssuer,
    knowledgeEnabled: config.knowledgeMode !== 'disabled',
    healthCheck: () => repository.healthCheck(),
    logger: dependencies.logger ?? true,
  });
  try {
    await repository.healthCheck();
    const address = await app.listen({ host: config.host, port: config.port });
    let closed = false;
    return {
      app,
      address,
      repository,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await app.close();
        } finally {
          await repository.close();
        }
      },
    };
  } catch (error) {
    await app.close();
    await repository.close();
    throw error;
  }
}

function createRepository(
  config: BusinessRuntimeConfig,
  dependencies: BusinessRuntimeDependencies,
): RuntimeBusinessRepository {
  if (config.repositoryMode === 'postgres') {
    const databaseUrl = config.databaseUrl;
    if (databaseUrl === null) throw new Error('PostgreSQL runtime is missing DATABASE_URL.');
    return (
      dependencies.createPostgresRepository?.(databaseUrl) ??
      new PostgresBusinessRepository(databaseUrl)
    );
  }
  return dependencies.createFakeRepository?.() ?? new FakeBusinessRepository();
}

function createAutomation(
  config: BusinessRuntimeConfig,
  clock: Clock,
  dependencies: BusinessRuntimeDependencies,
): AutomationPort {
  if (config.automationMode === 'disabled') return new DisabledAutomationProvider();
  if (config.automationMode === 'internal') {
    if (
      config.internalAutomationBaseUrl === null ||
      config.internalAutomationServiceToken === null
    ) {
      throw new Error('Internal automation runtime configuration is incomplete.');
    }
    return (
      dependencies.createInternalAutomation?.(
        config.internalAutomationBaseUrl,
        config.internalAutomationServiceToken,
      ) ??
      new InternalAutomationClient(
        config.internalAutomationBaseUrl,
        config.internalAutomationServiceToken,
      )
    );
  }
  return dependencies.createFakeAutomation?.(clock) ?? new FakeAutomationProvider(clock);
}
