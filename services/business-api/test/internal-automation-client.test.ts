import { describe, expect, it } from 'vitest';

import { InternalAutomationClient } from '../src/adapters/automation/internal-automation-client.js';
import { DEV_MANAGER, TENANT } from './helpers.js';

describe('InternalAutomationClient', () => {
  it('maps browser operation kind to the frozen internal purpose and schema id', async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      captured = { input, init };
      return Response.json(
        {
          id: '10000000-0000-4000-8000-000000000001',
          status: 'queued',
          output: null,
          error: null,
          created_at: '2026-08-18T10:00:00Z',
          completed_at: null,
        },
        { status: 202 },
      );
    };
    const client = new InternalAutomationClient(
      'http://control-plane.test',
      'service-token',
      fetchMock,
    );
    await client.start({
      tenantId: TENANT,
      actorUserId: DEV_MANAGER,
      kind: 'requirement_split',
      correlationId: '00000000-0000-4000-8000-000000003001',
      input: { title: 'test' },
      idempotencyKey: 'automation-key-001',
      requestId: 'request-0001',
    });
    const init = captured!.init;
    expect(JSON.parse(init!.body as string)).toMatchObject({
      purpose: 'task_split',
      output_schema_id: 'company.requirement-split.v1',
      tenant_id: TENANT,
      actor_user_id: DEV_MANAGER,
    });
    expect(init!.headers).toMatchObject({
      Authorization: 'Bearer service-token',
      'Idempotency-Key': 'automation-key-001',
      'X-Request-Id': 'request-0001',
    });
  });

  it('fails closed when a succeeded provider output violates its typed schema', async () => {
    const client = new InternalAutomationClient(
      'http://control-plane.test',
      'service-token',
      async () =>
        Response.json({
          id: '10000000-0000-4000-8000-000000000002',
          status: 'succeeded',
          output: { unexpected: true },
          error: null,
          created_at: '2026-08-18T10:00:00Z',
          completed_at: '2026-08-18T10:00:01Z',
        }),
    );
    await expect(
      client.get('10000000-0000-4000-8000-000000000002', 'request-0001', 'task_review'),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'provider_contract_invalid' },
      output: null,
    });
  });
});
