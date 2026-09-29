export type BusinessNodeEnv = 'development' | 'test' | 'production';
export type BusinessRepositoryMode = 'fake' | 'postgres';
export type AutomationProviderMode = 'disabled' | 'fake' | 'internal';
export type KnowledgeProviderMode = 'disabled' | 'fake' | 'remote-mcp';

export interface BusinessRuntimeConfig {
  nodeEnv: BusinessNodeEnv;
  host: string;
  port: number;
  repositoryMode: BusinessRepositoryMode;
  databaseUrl: string | null;
  automationMode: AutomationProviderMode;
  internalAutomationBaseUrl: string | null;
  internalAutomationServiceToken: string | null;
  knowledgeMode: KnowledgeProviderMode;
  actorTokenSecret: string;
  actorTokenIssuer: string;
}

export function loadBusinessRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BusinessRuntimeConfig {
  const nodeEnv = choice('NODE_ENV', env.NODE_ENV ?? 'development', [
    'development',
    'test',
    'production',
  ] as const);
  const repositoryMode = choice('BUSINESS_REPOSITORY', env.BUSINESS_REPOSITORY ?? 'fake', [
    'fake',
    'postgres',
  ] as const);
  const automationMode = choice('AUTOMATION_PROVIDER', env.AUTOMATION_PROVIDER ?? 'fake', [
    'disabled',
    'fake',
    'internal',
  ] as const);
  const knowledgeMode = choice('KNOWLEDGE_PROVIDER', env.KNOWLEDGE_PROVIDER ?? 'fake', [
    'disabled',
    'fake',
    'remote-mcp',
  ] as const);

  if (
    nodeEnv === 'production' &&
    (repositoryMode === 'fake' || automationMode === 'fake' || knowledgeMode === 'fake')
  ) {
    throw new Error('Production Business API rejects every fake repository and provider.');
  }
  if (knowledgeMode === 'remote-mcp') {
    throw new Error('Remote MCP is reserved and is not implemented by Business API.');
  }

  const actorTokenSecret = required(env, 'ACTOR_TOKEN_SECRET');
  if (actorTokenSecret.length < 32) {
    throw new Error('ACTOR_TOKEN_SECRET must contain at least 32 characters.');
  }

  let databaseUrl: string | null = null;
  if (repositoryMode === 'postgres') {
    databaseUrl = postgresUrl(required(env, 'DATABASE_URL'));
  }

  let internalAutomationBaseUrl: string | null = null;
  let internalAutomationServiceToken: string | null = null;
  if (automationMode === 'internal') {
    internalAutomationBaseUrl = httpUrl(required(env, 'INTERNAL_AUTOMATION_BASE_URL'));
    internalAutomationServiceToken = required(env, 'INTERNAL_AUTOMATION_SERVICE_TOKEN');
  }

  return {
    nodeEnv,
    host: nonEmpty(env.HOST ?? '127.0.0.1', 'HOST'),
    port: port(env.PORT ?? '3102'),
    repositoryMode,
    databaseUrl,
    automationMode,
    internalAutomationBaseUrl,
    internalAutomationServiceToken,
    knowledgeMode,
    actorTokenSecret,
    actorTokenIssuer: nonEmpty(
      env.ACTOR_TOKEN_ISSUER ?? 'company-control-plane',
      'ACTOR_TOKEN_ISSUER',
    ),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined) throw new Error(`${name} is required.`);
  return nonEmpty(value, name);
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function choice<const T extends readonly string[]>(
  name: string,
  value: string,
  values: T,
): T[number] {
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return parsed;
}

function postgresUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must be a PostgreSQL URL.');
  }
  return value;
}

function httpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('INTERNAL_AUTOMATION_BASE_URL must be a valid HTTP URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('INTERNAL_AUTOMATION_BASE_URL must be a valid HTTP URL.');
  }
  return parsed.toString();
}
