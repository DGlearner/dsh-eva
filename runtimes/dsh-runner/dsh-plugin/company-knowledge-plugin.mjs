import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ControlPlaneSystemQueryClient,
  registerCompanyKnowledgeTools,
  registerCompanySystemTools,
} from '@company/dsh-runner';

export const name = 'company-knowledge';
export const inject = ['tools'];

export function apply(ctx) {
  const tenantId = required('COMPANY_TENANT_ID');
  const userId = required('COMPANY_USER_ID');
  const runnerId = required('COMPANY_RUNNER_ID');
  const home = required('DSH_HOME');
  const identity = readJson(join(home, '.company', 'identity.json'));
  const model = readJson(join(home, '.company', 'model.json'));
  const knowledge = readJson(join(home, '.company', 'knowledge.json'));
  if (identity.tenant_id !== tenantId || identity.user_id !== userId) {
    throw new Error('materialized identity does not match the runner identity');
  }
  if (typeof identity.username !== 'string' || typeof identity.display_name !== 'string') {
    throw new Error('materialized identity is incomplete');
  }
  const context = {
    tenantId,
    userId,
    username: identity.username,
    displayName: identity.display_name,
  };
  const events = (execution) => ({
    append(type, data) {
      if (!execution?.agent) throw new Error(`${type} requires an owning agent session`);
      execution.agent.session.append(type, data, { ignorable: true });
    },
  });
  if (knowledge.provider === 'fake') {
    registerCompanyKnowledgeTools({
      registry: ctx.tools,
      defineTool,
      context,
      events,
    });
  } else if (knowledge.provider !== 'disabled' && knowledge.provider !== 'remote-mcp') {
    throw new Error(`knowledge provider ${String(knowledge.provider)} is not implemented`);
  }
  if (knowledge.provider === 'remote-mcp') {
    const allowed = new Set(
      requiredStringArray(knowledge.allowedTools, 'knowledge.allowedTools').map(
        (tool) => `mcp__xiaopai__${tool}`,
      ),
    );
    ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.name.startsWith('mcp__xiaopai__') && !allowed.has(execution.name)) {
        return { kind: 'deny', reason: 'MCP tool is not enabled for this company deployment' };
      }
      return next();
    });
  }
  registerCompanySystemTools({
    registry: ctx.tools,
    defineTool,
    context,
    events,
    port: new ControlPlaneSystemQueryClient({
      endpoint: required('COMPANY_AGENT_TOOL_GATEWAY_URL'),
      tenantId,
      userId,
      runnerId,
      identitySecretBase64: required('COMPANY_RUNNER_IDENTITY_SECRET_BASE64'),
    }),
  });
  if (model.configured !== false) {
    ctx.on('agent/request', async (_payload, next) => ({
      ...(await next()),
      temperature: number(model.temperature, 'temperature'),
      ...(model.maxOutputTokens === null
        ? {}
        : { maxTokens: positiveInteger(model.maxOutputTokens, 'maxOutputTokens') }),
    }));
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} is invalid`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid`);
  return value;
}

function requiredStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
