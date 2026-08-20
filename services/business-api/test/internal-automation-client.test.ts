import { describe, expect, it } from 'vitest';

import { InternalAutomationClient } from '../src/adapters/automation/internal-automation-client.js';
import type { GetAutomationInput, StartAutomationInput } from '../src/ports/automation.js';
import { DEV_MANAGER, TENANT } from './helpers.js';

const RUN_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_RUN_ID = '10000000-0000-4000-8000-000000000002';
const CORRELATION_ID = '00000000-0000-4000-8000-000000003001';
const OTHER_ID = '00000000-0000-4000-8000-000000003002';

const startInput: StartAutomationInput = {
  tenantId: TENANT,
  actorUserId: DEV_MANAGER,
  kind: 'requirement_split',
  correlationId: CORRELATION_ID,
  input: { title: 'test' },
  idempotencyKey: 'automation-key-001',
  requestId: 'request-0001',
};

const getInput: GetAutomationInput = {
  runId: RUN_ID,
  requestId: 'request-0001',
  tenantId: TENANT,
  actorUserId: DEV_MANAGER,
  kind: 'task_review',
  correlationId: CORRELATION_ID,
};

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    tenant_id: TENANT,
    actor_user_id: DEV_MANAGER,
    purpose: 'task_review',
    correlation_id: CORRELATION_ID,
    status: 'queued',
    output_schema_id: 'company.task-review.v1',
    output: null,
    error: null,
    created_at: '2026-08-18T10:00:00Z',
    completed_at: null,
    ...overrides,
  };
}

function clientWith(payload: unknown, status = 200): InternalAutomationClient {
  return new InternalAutomationClient('http://control-plane.test', 'service-token', async () =>
    Response.json(payload, { status }),
  );
}

describe('InternalAutomationClient', () => {
  it('maps the operation kind and validates the complete POST response context', async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined;
    const client = new InternalAutomationClient(
      'http://control-plane.test',
      'service-token',
      async (input, init) => {
        captured = { input, init };
        return Response.json(
          run({
            purpose: 'task_split',
            output_schema_id: 'company.requirement-split.v1',
          }),
          { status: 202 },
        );
      },
    );

    await expect(client.start(startInput)).resolves.toMatchObject({ id: RUN_ID, status: 'queued' });
    expect(JSON.parse(captured!.init!.body as string)).toEqual({
      tenant_id: TENANT,
      actor_user_id: DEV_MANAGER,
      purpose: 'task_split',
      correlation_id: CORRELATION_ID,
      input: { title: 'test' },
      output_schema_id: 'company.requirement-split.v1',
    });
    expect(captured!.init!.headers).toMatchObject({
      Authorization: 'Bearer service-token',
      'Idempotency-Key': 'automation-key-001',
      'X-Request-Id': 'request-0001',
    });
  });

  it.each([
    ['tenant_id', OTHER_ID],
    ['actor_user_id', OTHER_ID],
    ['purpose', 'daily_rewrite'],
    ['correlation_id', OTHER_ID],
    ['output_schema_id', 'company.daily-rewrite.v1'],
  ])('rejects a POST response with mismatched %s', async (field, value) => {
    const payload = run({
      purpose: 'task_split',
      output_schema_id: 'company.requirement-split.v1',
      [field]: value,
    });
    await expect(clientWith(payload, 202).start(startInput)).rejects.toMatchObject({
      status: 503,
      code: 'dependency_unavailable',
    });
  });

  it.each([
    ['id', OTHER_RUN_ID],
    ['tenant_id', OTHER_ID],
    ['correlation_id', OTHER_ID],
  ])('rejects a GET response with mismatched %s', async (field, value) => {
    await expect(clientWith(run({ [field]: value })).get(getInput)).rejects.toMatchObject({
      status: 503,
      code: 'dependency_unavailable',
    });
  });

  it('accepts a directly succeeded typed review result', async () => {
    const output = {
      result: 'pass',
      summary: 'All checks passed.',
      checks: [{ name: 'evidence', passed: true, detail: 'Present.' }],
      evidence: [{ kind: 'text', label: 'test', value: 'passed' }],
      executor_version: 'automation-v1',
    };
    await expect(
      clientWith(
        run({
          status: 'succeeded',
          output,
          completed_at: '2026-08-18T10:00:01Z',
        }),
      ).get(getInput),
    ).resolves.toMatchObject({ status: 'succeeded', output });
  });

  it.each([
    ['failed', { code: 'executor_failed', message: 'Execution failed.' }],
    ['cancelled', null],
  ] as const)('accepts a valid %s terminal response', async (status, error) => {
    await expect(
      clientWith(run({ status, error, completed_at: '2026-08-18T10:00:01Z' })).get(getInput),
    ).resolves.toMatchObject({ status, error, output: null });
  });

  it.each([null, { unexpected: true }])(
    'converts a succeeded invalid output into provider_contract_invalid',
    async (output) => {
      await expect(
        clientWith(run({ status: 'succeeded', output, completed_at: '2026-08-18T10:00:01Z' })).get(
          getInput,
        ),
      ).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'provider_contract_invalid' },
        output: null,
      });
    },
  );

  it.each([
    run({ status: 'running', completed_at: '2026-08-18T10:00:01Z' }),
    run({ status: 'failed', error: null, completed_at: '2026-08-18T10:00:01Z' }),
    run({
      status: 'cancelled',
      output: { unexpected: true },
      completed_at: '2026-08-18T10:00:01Z',
    }),
    run({ unexpected: true }),
  ])('rejects malformed fields or status invariants', async (payload) => {
    await expect(clientWith(payload).get(getInput)).rejects.toMatchObject({
      status: 503,
      code: 'dependency_unavailable',
    });
  });

  it('requires the endpoint-specific HTTP status', async () => {
    const postPayload = run({
      purpose: 'task_split',
      output_schema_id: 'company.requirement-split.v1',
    });
    await expect(clientWith(postPayload).start(startInput)).rejects.toMatchObject({ status: 503 });
    await expect(clientWith(run(), 202).get(getInput)).rejects.toMatchObject({ status: 503 });
  });
});
