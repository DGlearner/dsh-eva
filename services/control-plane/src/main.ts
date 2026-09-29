import { createLogger } from '@company/observability';
import { RunnerConfigMaterializer, type MaterializedConfigStage } from '@company/dsh-runner';

import { buildControlPlane } from './app.js';
import { registerAgentToolGateway } from './agent-tool-gateway.js';
import { createRuntimeAutomationExecutor } from './automation.js';
import { registerBusinessGateway } from './business-gateway.js';
import { registerDshGateway } from './gateway.js';
import { deriveRunnerConfigVersion, resolveUserKnowledgeAccess } from './knowledge-access.js';
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
const runnerIdentityRootSecret = Buffer.from(required('RUNNER_IDENTITY_SECRET_BASE64'), 'base64');
const businessApiUrl = required('BUSINESS_API_URL');
const actorTokenSecret = required('ACTOR_TOKEN_SECRET');
const actorTokenIssuer = process.env.ACTOR_TOKEN_ISSUER ?? 'company-control-plane';
const configMaterializer = new RunnerConfigMaterializer(dataRoot);
const secretCipher = SecretCipher.fromBase64(required('MODEL_SECRET_KEY_BASE64'));
const validateModelUrl = async (value: string) =>
  validateExternalBaseUrl(value, { allowedAuthorities: modelUrlAllowlist() });
const runnerRefreshStageId = '00000000-0000-4000-8000-000000000100';
const app = buildControlPlane({
  repository,
  secretCipher,
  secureCookies: process.env.NODE_ENV === 'production',
  serviceToken: required('INTERNAL_SERVICE_TOKEN'),
  validateModelUrl,
  runnerAdminClient: runnerClient,
  automationExecutor: createRuntimeAutomationExecutor(
    process.env.AUTOMATION_EXECUTOR,
    process.env.NODE_ENV,
    { repository, secretCipher, validateModelUrl },
  ),
  configMaterializer: {
    stage: async ({ stageId, tenantId, userId, username, displayName, config, apiKey }) => {
      const knowledge = await resolveUserKnowledgeAccess(repository, secretCipher, {
        tenantId,
        userId,
      });
      const runnerConfigVersion = deriveRunnerConfigVersion({
        modelConfigVersion: config.configVersion,
        knowledgeRevision: knowledge.revision,
      });
      const handle = await configMaterializer.stage({
        stageId,
        tenantId,
        userId,
        username,
        displayName,
        model: {
          baseUrl: config.baseUrl,
          defaultModel: config.model,
          models: config.models,
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          configVersion: config.configVersion,
        },
        runnerConfigVersion,
        apiKey,
        knowledge: knowledge.config,
        knowledgeCredential: knowledge.credential,
        production: process.env.NODE_ENV === 'production',
      });
      return { stageId, userId, configVersion: handle.configVersion, handle };
    },
    activate: async (stage) => configMaterializer.activate(stage.handle as MaterializedConfigStage),
    rollback: async (stage) => configMaterializer.rollback(stage.handle as MaterializedConfigStage),
  },
});

registerDshGateway(app, {
  repository,
  runnerLocator: runnerClient,
  runnerIdentitySecret: runnerIdentityRootSecret,
  prepareRunner: async (user, model) => {
    const knowledge = await resolveUserKnowledgeAccess(repository, secretCipher, {
      tenantId: user.tenantId,
      userId: user.id,
    });
    const runnerConfigVersion = deriveRunnerConfigVersion({
      modelConfigVersion: model?.configVersion ?? null,
      knowledgeRevision: knowledge.revision,
    });
    const active = await configMaterializer.hasActiveVersion({
      userId: user.id,
      configVersion: runnerConfigVersion,
    });
    if (active) return runnerConfigVersion;
    const stage = await configMaterializer.stage({
      stageId: runnerRefreshStageId,
      tenantId: user.tenantId,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      model: model
        ? {
            baseUrl: model.baseUrl,
            defaultModel: model.model,
            models: model.models,
            temperature: model.temperature,
            maxOutputTokens: model.maxOutputTokens,
            configVersion: model.configVersion,
          }
        : { configured: false, configVersion: 1 },
      runnerConfigVersion,
      apiKey: model?.apiKeyCiphertext ? secretCipher.open(model.apiKeyCiphertext) : null,
      knowledge: knowledge.config,
      knowledgeCredential: knowledge.credential,
      production: process.env.NODE_ENV === 'production',
    });
    await configMaterializer.activate(stage);
    return stage.configVersion;
  },
  workbenchEntryUrl: process.env.WORKBENCH_ENTRY_URL ?? '/workbench',
});
registerBusinessGateway(app, {
  repository,
  businessApiUrl,
  actorTokenSecret,
  actorTokenIssuer,
});
registerAgentToolGateway(app, {
  repository,
  runnerRegistry: runnerClient,
  runnerIdentityRootSecret,
  businessApiUrl,
  actorTokenSecret,
  actorTokenIssuer,
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

function modelUrlAllowlist(): ReadonlySet<string> {
  return new Set(
    (process.env.MODEL_BASE_URL_ALLOWLIST ?? '')
      .split(',')
      .map((authority) => authority.trim().toLocaleLowerCase('en-US'))
      .filter(Boolean),
  );
}
