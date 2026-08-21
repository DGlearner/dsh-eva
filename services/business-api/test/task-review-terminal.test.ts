import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeBusinessRepository } from '../src/adapters/fake/fake-business-repository.js';
import { buildBusinessApp } from '../src/app.js';
import type { AutomationResult, AutomationRunStatus } from '../src/domain/models.js';
import type {
  AutomationPort,
  AutomationProviderRun,
  GetAutomationInput,
  StartAutomationInput,
} from '../src/ports/automation.js';
import { FixedClock } from '../src/ports/clock.js';
import { actors, authHeaders, ISSUER, SECRET } from './helpers.js';

const TASK_ID = '00000000-0000-4000-8000-000000004003';
const SUBMISSION_ID = '00000000-0000-4000-8000-000000004902';
const PROVIDER_RUN_ID = '10000000-0000-4000-8000-000000000101';
const NOW = '2026-08-18T10:00:00.000Z';

const reviewOutput = {
  result: 'pass',
  summary: 'All automated checks passed.',
  checks: [{ name: 'evidence', passed: true, detail: 'Evidence is present.' }],
  evidence: [{ kind: 'text', label: 'test', value: 'passed' }],
  executor_version: 'immediate-provider-v1',
} satisfies AutomationResult;

class ImmediateAutomationProvider implements AutomationPort {
  readonly provider = 'dsh' as const;

  constructor(
    private readonly terminal: AutomationProviderRun,
    private readonly started: AutomationProviderRun = terminal,
  ) {}

  async start(_input: StartAutomationInput): Promise<AutomationProviderRun> {
    return structuredClone(this.started);
  }

  async get(_input: GetAutomationInput): Promise<AutomationProviderRun> {
    return structuredClone(this.terminal);
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createContext(
  status: AutomationRunStatus,
  output: AutomationResult | null,
  startStatus: AutomationRunStatus = status,
) {
  const repository = new FakeBusinessRepository();
  const error =
    status === 'failed' ? { code: 'executor_failed', message: 'Execution failed.' } : null;
  const terminal: AutomationProviderRun = {
    id: PROVIDER_RUN_ID,
    status,
    output,
    error,
    createdAt: NOW,
    completedAt: NOW,
  };
  const automation = new ImmediateAutomationProvider(terminal, {
    ...terminal,
    status: startStatus,
    output: startStatus === 'succeeded' ? output : null,
    error: startStatus === 'failed' ? error : null,
    completedAt:
      startStatus === 'queued' || startStatus === 'running' ? null : terminal.completedAt,
  });
  const app = buildBusinessApp({
    repository,
    automation,
    clock: new FixedClock(new Date(NOW)),
    actorTokenSecret: SECRET,
    actorTokenIssuer: ISSUER,
  });
  apps.push(app);
  return { app, repository };
}

async function startReview(app: FastifyInstance, key: string) {
  return app.inject({
    method: 'POST',
    url: `/company-api/v1/tasks/${TASK_ID}/review-runs`,
    headers: await authHeaders(actors.manager, { 'idempotency-key': key }),
    payload: { submission_id: SUBMISSION_ID, expected_version: 4 },
  });
}

describe('Task review terminal synchronization', () => {
  it('atomically applies a directly succeeded provider result without completing the task', async () => {
    const { app, repository } = createContext('succeeded', reviewOutput);
    const response = await startReview(app, 'review-immediate-success');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'succeeded', result: reviewOutput });
    expect(await repository.getTask(actors.manager.tenantId, TASK_ID)).toMatchObject({
      status: 'review',
      latest_review_result: 'pass',
      version: 5,
    });
    expect((await repository.listTaskReviewRuns(TASK_ID)).at(-1)).toMatchObject({
      status: 'succeeded',
      result: 'pass',
      executor_version: 'immediate-provider-v1',
      completed_at: NOW,
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'persists an immediately %s review run without changing the task result',
    async (status) => {
      const { app, repository } = createContext(status, null);
      const response = await startReview(app, `review-immediate-${status}`);

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ status, result: null });
      expect(await repository.getTask(actors.manager.tenantId, TASK_ID)).toMatchObject({
        status: 'review',
        latest_review_result: 'needs_review',
        version: 4,
      });
      expect((await repository.listTaskReviewRuns(TASK_ID)).at(-1)).toMatchObject({
        status,
        result: null,
        completed_at: NOW,
      });
    },
  );

  it.each(['failed', 'cancelled'] as const)(
    'synchronizes a queued review run when polling reaches %s',
    async (status) => {
      const { app, repository } = createContext(status, null, 'queued');
      const started = await startReview(app, `review-polled-${status}`);
      expect(started.json()).toMatchObject({ status: 'queued' });

      const polled = await app.inject({
        method: 'GET',
        url: `/company-api/v1/automation-operations/${started.json().id}`,
        headers: await authHeaders(actors.manager),
      });

      expect(polled.statusCode).toBe(200);
      expect(polled.json()).toMatchObject({ status });
      expect((await repository.listTaskReviewRuns(TASK_ID)).at(-1)).toMatchObject({
        status,
        result: null,
        completed_at: NOW,
      });
    },
  );

  it('records a succeeded run with no output as a provider contract failure', async () => {
    const { app, repository } = createContext('succeeded', null);
    const response = await startReview(app, 'review-immediate-empty-output');

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'failed',
      result: null,
      error: { code: 'provider_contract_invalid' },
    });
    expect((await repository.listTaskReviewRuns(TASK_ID)).at(-1)).toMatchObject({
      status: 'failed',
      result: null,
      executor_version: 'provider_contract_invalid',
    });
    expect(await repository.getTask(actors.manager.tenantId, TASK_ID)).toMatchObject({
      status: 'review',
      latest_review_result: 'needs_review',
      version: 4,
    });
  });

  it('rolls back an immediate result when updating the task fails', async () => {
    const { app, repository } = createContext('succeeded', reviewOutput);
    repository.failNext('saveTask');

    const failed = await startReview(app, 'review-immediate-rollback');

    expect(failed.statusCode).toBe(500);
    expect(await repository.listTaskReviewRuns(TASK_ID)).toHaveLength(1);
    expect(await repository.getTask(actors.manager.tenantId, TASK_ID)).toMatchObject({
      latest_review_result: 'needs_review',
      version: 4,
    });
    expect(
      await repository.getIdempotencyRecord(
        actors.manager.tenantId,
        actors.manager.userId,
        `POST /tasks/${TASK_ID}/review-runs`,
        'review-immediate-rollback',
      ),
    ).toBeNull();

    const recovered = await startReview(app, 'review-immediate-rollback');
    expect(recovered.statusCode).toBe(202);
    expect(await repository.listTaskReviewRuns(TASK_ID)).toHaveLength(2);
    expect(await repository.getTask(actors.manager.tenantId, TASK_ID)).toMatchObject({
      latest_review_result: 'pass',
      version: 5,
    });
  });
});
