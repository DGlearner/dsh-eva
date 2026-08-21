import { createLogger } from '@company/observability';
import { RunnerConfigMaterializer, type MaterializedConfigStage } from '@company/dsh-runner';

import { buildControlPlane } from './app.js';
import { registerBusinessGateway } from './business-gateway.js';
import { registerDshGateway } from './gateway.js';
import { PgPlatformRepository } from './pg-repository.js';
import { RunnerManagerHttpClient } from './runner-client.js';
import { SecretCipher, validateExternalBaseUrl } from './security.js';

const logger = createLogger('control-plane');
const repository = new PgPlatformRepository(required('DATABASE_URL'));
const runnerClient = new RunnerManagerHttpClient(
  required('RUNNER_MANAGER_URL'),
  required('INTERNAL_SERVICE_TOKEN'),
);
const dataRoot = required('RUNNER_DATA_ROOT');
const configMaterializer = new RunnerConfigMaterializer(dataRoot);
const app = buildControlPlane({
  repository,
  secretCipher: SecretCipher.fromBase64(required('MODEL_SECRET_KEY_BASE64')),
  secureCookies: process.env.NODE_ENV === 'production',
  serviceToken: required('INTERNAL_SERVICE_TOKEN'),
  validateModelUrl: async (value) =>
    validateExternalBaseUrl(value, { allowedAuthorities: modelUrlAllowlist() }),
  runnerAdminClient: runnerClient,
  configMaterializer: {
    stage: async ({ stageId, tenantId, userId, username, displayName, config, apiKey }) => {
      const handle = await configMaterializer.stage({
        stageId,
        tenantId,
        userId,
        username,
        displayName,
        model: {
          baseUrl: config.baseUrl,
          model: config.model,
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          configVersion: config.configVersion,
        },
        apiKey,
        knowledge: knowledgeConfig(),
        production: process.env.NODE_ENV === 'production',
      });
      return { stageId, userId, configVersion: config.configVersion, handle };
    },
    activate: async (stage) => configMaterializer.activate(stage.handle as MaterializedConfigStage),
    rollback: async (stage) => configMaterializer.rollback(stage.handle as MaterializedConfigStage),
  },
});

registerDshGateway(app, {
  repository,
  runnerLocator: runnerClient,
  runnerIdentitySecret: Buffer.from(required('RUNNER_IDENTITY_SECRET_BASE64'), 'base64'),
  workbenchEntryUrl: process.env.WORKBENCH_ENTRY_URL ?? '/workbench',
});
registerBusinessGateway(app, {
  repository,
  businessApiUrl: required('BUSINESS_API_URL'),
  actorTokenSecret: required('ACTOR_TOKEN_SECRET'),
  actorTokenIssuer: process.env.ACTOR_TOKEN_ISSUER ?? 'company-control-plane',
});

const address = await app.listen({
  host: process.env.CONTROL_PLANE_HOST ?? '127.0.0.1',
  port: numberEnv('CONTROL_PLANE_PORT', 8080),
});
logger.info({ address }, 'control plane listening');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().finally(async () => {
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
  if (!Number.isInteger(number) || number < 1 || number > 65_535)
    throw new Error(`${name} is invalid`);
  return number;
}

function knowledgeConfig() {
  if ((process.env.KNOWLEDGE_PROVIDER ?? 'fake') === 'fake') return { provider: 'fake' as const };
  if (process.env.KNOWLEDGE_PROVIDER !== 'remote-mcp') {
    throw new Error('KNOWLEDGE_PROVIDER must be fake or remote-mcp');
  }
  return {
    provider: 'remote-mcp' as const,
    remoteMcpEnabled: process.env.REMOTE_MCP_ENABLED === 'true',
    mcpUrl: process.env.REMOTE_MCP_URL,
    authSecretRef: process.env.REMOTE_MCP_AUTH_SECRET_REF,
  };
}

function modelUrlAllowlist(): ReadonlySet<string> {
  return new Set(
    (process.env.MODEL_BASE_URL_ALLOWLIST ?? '')
      .split(',')
      .map((authority) => authority.trim().toLocaleLowerCase('en-US'))
      .filter(Boolean),
  );
}
