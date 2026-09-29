import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ControlPlaneSystemQueryClient,
  normalizeSystemQueryInput,
  registerCompanySystemTools,
} from './system-query.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const runnerId = '00000000-0000-4000-8000-000000000010';
const secret = Buffer.alloc(32, 8);
const context = {
  tenantId,
  userId,
  username: 'dev_a',
  displayName: 'Dev A',
};

describe('Company system query Tool', () => {
  it('allows only the frozen read-only resource parameters', () => {
    expect(
      normalizeSystemQueryInput({
        resource: 'tasks',
        view: 'assigned_to_me',
        status: 'in_progress',
        from: '2026-08-01',
        to: '2026-08-23',
        limit: 20,
      }),
    ).toEqual({
      resource: 'tasks',
      view: 'assigned_to_me',
      status: 'in_progress',
      from: '2026-08-01',
      to: '2026-08-23',
      limit: 20,
    });
    expect(() => normalizeSystemQueryInput({ resource: 'tasks', user_id: userId })).toThrow(
      'user_id is not allowed',
    );
    expect(() =>
      normalizeSystemQueryInput({ resource: 'task', record_id: runnerId, status: 'done' }),
    ).toThrow('status is not allowed for task');
    expect(() =>
      normalizeSystemQueryInput({
        resource: 'department_daily_reports',
        from: '2026-09-01',
        to: '2026-08-01',
      }),
    ).toThrow('from must not exceed to');
    expect(normalizeSystemQueryInput({ resource: 'daily_reports', view: 'mine' })).toEqual({
      resource: 'daily_reports',
    });
    expect(
      normalizeSystemQueryInput({ resource: 'daily_report', work_date: '2026-08-23' }),
    ).toEqual({ resource: 'daily_report', work_date: '2026-08-23', scope: 'department' });
    expect(
      normalizeSystemQueryInput({
        resource: 'daily_report',
        work_date: '2026-08-23',
        scope: 'task',
        task_id: runnerId,
      }),
    ).toMatchObject({ scope: 'task', task_id: runnerId });
    expect(() => normalizeSystemQueryInput({ resource: 'daily_reports', scope: 'task' })).toThrow(
      'task_id is required only for task reports',
    );
    expect(() =>
      normalizeSystemQueryInput({ resource: 'daily_reports', view: 'department' }),
    ).toThrow('view is invalid for daily_reports');
  });

  it('registers one read-only Tool and persists its call and result events', async () => {
    const definitions: Array<{
      name: string;
      output: { schema: Record<string, unknown> };
      execute(args: unknown, execution: unknown): Promise<unknown>;
    }> = [];
    const append = vi.fn();
    registerCompanySystemTools({
      registry: { register: (tool) => definitions.push(tool) },
      defineTool: (definition) => definition,
      context,
      events: { append },
      port: { query: async (_context, input) => ({ items: [input] }) },
    });
    expect(definitions.map((definition) => definition.name)).toEqual(['query_company_system']);
    expect(definitions[0]?.output.schema).toEqual({ type: 'object', additionalProperties: true });
    await expect(
      definitions[0]!.execute({ resource: 'daily_reports', scope: 'department', limit: 10 }, {}),
    ).resolves.toEqual({
      items: [{ resource: 'daily_reports', scope: 'department', limit: 10 }],
    });
    expect(append.mock.calls.map(([type]) => type)).toEqual([
      'company/tool-call',
      'company/tool-result',
    ]);
  });

  it('binds the request to this Runner and hides upstream error details', async () => {
    let captured: RequestInit | undefined;
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = init;
      return Response.json(
        { code: 'secret-upstream-detail', token: 'must-not-leak' },
        { status: 403 },
      );
    });
    const client = new ControlPlaneSystemQueryClient({
      endpoint: 'http://control-plane:8080/internal/v1/agent-tools/query-company-system',
      tenantId,
      userId,
      runnerId,
      identitySecretBase64: secret.toString('base64'),
      fetch: fetcher as typeof fetch,
    });
    await expect(client.query(context, { resource: 'requirements', limit: 10 })).rejects.toThrow(
      'Company system query failed (403 secret-upstream-detail)',
    );
    const headers = new Headers(captured?.headers);
    const token = headers.get('authorization')!.slice('Bearer '.length);
    const [protectedSegment, payloadSegment, signature] = token.split('.');
    expect(signature).toBe(
      createHmac('sha256', secret)
        .update(`${protectedSegment}.${payloadSegment}`, 'ascii')
        .digest('base64url'),
    );
    const payload = JSON.parse(
      Buffer.from(payloadSegment!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      iss: 'company-dsh-runner',
      aud: 'company-agent-tool-gateway',
      tenant_id: tenantId,
      user_id: userId,
      runner_id: runnerId,
    });
    expect(headers.get('x-request-id')).toBe(payload.request_id);
    expect(captured?.body).toBe(JSON.stringify({ resource: 'requirements', limit: 10 }));
    await expect(
      client.query({ ...context, userId: runnerId }, { resource: 'requirements' }),
    ).rejects.toThrow('does not match the runner identity');
  });
});
