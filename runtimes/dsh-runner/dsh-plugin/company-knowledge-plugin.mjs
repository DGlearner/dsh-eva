import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerCompanyKnowledgeTools } from '@company/dsh-runner';

export const name = 'company-knowledge';
export const inject = ['tools'];

export function apply(ctx) {
  const tenantId = required('COMPANY_TENANT_ID');
  const userId = required('COMPANY_USER_ID');
  const home = required('DSH_HOME');
  const identity = readJson(join(home, '.company', 'identity.json'));
  const model = readJson(join(home, '.company', 'model.json'));
  if (identity.tenant_id !== tenantId || identity.user_id !== userId) {
    throw new Error('materialized identity does not match the runner identity');
  }
  if (typeof identity.username !== 'string' || typeof identity.display_name !== 'string') {
    throw new Error('materialized identity is incomplete');
  }
  registerCompanyKnowledgeTools({
    registry: ctx.tools,
    defineTool,
    context: {
      tenantId,
      userId,
      username: identity.username,
      displayName: identity.display_name,
    },
    events: (execution) => ({
      append(type, data) {
        if (!execution?.agent) throw new Error(`${type} requires an owning agent session`);
        execution.agent.session.append(type, data, { ignorable: true });
      },
    }),
  });
  ctx.on('agent/request', async (_payload, next) => ({
    ...(await next()),
    temperature: number(model.temperature, 'temperature'),
    ...(model.maxOutputTokens === null
      ? {}
      : { maxTokens: positiveInteger(model.maxOutputTokens, 'maxOutputTokens') }),
  }));
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

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
