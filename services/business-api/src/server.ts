import { FakeAutomationProvider } from './adapters/automation/fake-automation-provider.js';
import { InternalAutomationClient } from './adapters/automation/internal-automation-client.js';
import { FakeBusinessRepository } from './adapters/fake/fake-business-repository.js';
import { PostgresBusinessRepository } from './adapters/postgres/postgres-business-repository.js';
import { buildBusinessApp } from './app.js';
import type { AutomationPort } from './ports/automation.js';
import { SystemClock } from './ports/clock.js';
import type { BusinessRepository } from './ports/repository.js';

const nodeEnv = process.env.NODE_ENV ?? 'development';
const clock = new SystemClock();
const repositoryMode = process.env.BUSINESS_REPOSITORY ?? 'fake';
const automationMode = process.env.AUTOMATION_PROVIDER ?? 'fake';
const knowledgeMode = process.env.KNOWLEDGE_PROVIDER ?? 'fake';

if (
  nodeEnv === 'production' &&
  (repositoryMode === 'fake' || automationMode === 'fake' || knowledgeMode === 'fake')
) {
  throw new Error(
    'Fake repository, automation, and knowledge providers are disabled in production.',
  );
}
if (knowledgeMode !== 'fake') {
  throw new Error(
    'Remote knowledge is a reserved integration entry and is not enabled in this development wave.',
  );
}

let repository: BusinessRepository;
if (repositoryMode === 'postgres') {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for PostgreSQL mode.');
  repository = new PostgresBusinessRepository(databaseUrl);
} else if (repositoryMode === 'fake') {
  repository = new FakeBusinessRepository();
} else {
  throw new Error(`Unsupported BUSINESS_REPOSITORY: ${repositoryMode}`);
}

let automation: AutomationPort;
if (automationMode === 'internal') {
  const baseUrl = process.env.INTERNAL_AUTOMATION_BASE_URL;
  const token = process.env.INTERNAL_AUTOMATION_SERVICE_TOKEN;
  if (baseUrl === undefined || token === undefined) {
    throw new Error('Internal automation URL and service token are required.');
  }
  automation = new InternalAutomationClient(baseUrl, token);
} else if (automationMode === 'fake') {
  automation = new FakeAutomationProvider(clock);
} else {
  throw new Error(`Unsupported AUTOMATION_PROVIDER: ${automationMode}`);
}

const app = buildBusinessApp({
  repository,
  automation,
  clock,
  actorTokenSecret:
    process.env.ACTOR_TOKEN_SECRET ?? 'development-only-actor-token-secret-change-me',
  actorTokenIssuer: process.env.ACTOR_TOKEN_ISSUER ?? 'company-control-plane',
  logger: true,
});

const port = Number.parseInt(process.env.PORT ?? '3102', 10);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
