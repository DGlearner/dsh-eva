import { z } from 'zod';

import { dependencyUnavailable } from '../../domain/errors.js';
import type { AutomationKind, AutomationResult } from '../../domain/models.js';
import type {
  AutomationPort,
  AutomationProviderRun,
  GetAutomationInput,
  StartAutomationInput,
} from '../../ports/automation.js';

const evidenceSchema = z.object({
  kind: z.enum(['url', 'text', 'file_ref']),
  label: z.string(),
  value: z.string(),
});
const reviewCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean().nullable(),
  detail: z.string(),
});
const splitResultSchema = z.object({
  tasks: z.array(
    z.object({
      client_id: z.string(),
      title: z.string(),
      description: z.string(),
      acceptance_criteria: z.array(z.string()),
      assignee_user_id: z.string().uuid().nullable(),
      depends_on_client_ids: z.array(z.string()),
      position: z.number().int().nonnegative(),
    }),
  ),
});
const reviewResultSchema = z.object({
  result: z.enum(['pass', 'fail', 'needs_review']),
  summary: z.string(),
  checks: z.array(reviewCheckSchema),
  evidence: z.array(evidenceSchema),
  executor_version: z.string(),
});
const contentSchema = z.object({
  completed_today: z.string(),
  next_plan: z.string(),
  blockers: z.string(),
  other: z.string(),
  free_text: z.string().nullable(),
});
const rewriteResultSchema = z.object({ content: contentSchema });
const timestampSchema = z.string().datetime({ offset: true });
const runSchema = z
  .object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    actor_user_id: z.string().uuid(),
    purpose: z.enum(['task_split', 'task_review', 'daily_rewrite']),
    correlation_id: z.string().uuid(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    output_schema_id: z.enum([
      'company.requirement-split.v1',
      'company.task-review.v1',
      'company.daily-rewrite.v1',
    ]),
    output: z.record(z.string(), z.unknown()).nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    created_at: timestampSchema,
    completed_at: timestampSchema.nullable(),
  })
  .strict();

type AutomationRunPayload = z.infer<typeof runSchema>;

const schemaIds: Record<AutomationKind, string> = {
  requirement_split: 'company.requirement-split.v1',
  task_review: 'company.task-review.v1',
  daily_rewrite: 'company.daily-rewrite.v1',
};

const purposes: Record<AutomationKind, string> = {
  requirement_split: 'task_split',
  task_review: 'task_review',
  daily_rewrite: 'daily_rewrite',
};

export class InternalAutomationClient implements AutomationPort {
  readonly provider = 'dsh' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async start(input: StartAutomationInput): Promise<AutomationProviderRun> {
    return this.request(
      '/internal/v1/automation-runs',
      input.requestId,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          tenant_id: input.tenantId,
          actor_user_id: input.actorUserId,
          purpose: purposes[input.kind],
          correlation_id: input.correlationId,
          input: input.input,
          output_schema_id: schemaIds[input.kind],
        }),
      },
      202,
      {
        runId: null,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        kind: input.kind,
        correlationId: input.correlationId,
      },
    );
  }

  async get(input: GetAutomationInput): Promise<AutomationProviderRun> {
    return this.request(
      `/internal/v1/automation-runs/${input.runId}`,
      input.requestId,
      { method: 'GET' },
      200,
      input,
    );
  }

  private async request(
    path: string,
    requestId: string,
    init: RequestInit,
    expectedStatus: number,
    expected: {
      runId: string | null;
      tenantId: string;
      actorUserId: string;
      kind: AutomationKind;
      correlationId: string;
    },
  ): Promise<AutomationProviderRun> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.serviceToken}`,
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
          ...init.headers,
        },
      });
    } catch {
      throw dependencyUnavailable('Internal automation service is unavailable.');
    }
    if (response.status !== expectedStatus) {
      throw dependencyUnavailable(`Internal automation service returned ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw dependencyUnavailable('Internal automation service returned invalid JSON.');
    }
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      throw dependencyUnavailable('Internal automation service returned an invalid run payload.');
    }
    this.assertContext(parsed.data, expected);
    this.assertStatusInvariant(parsed.data);
    if (parsed.data.status === 'succeeded' && parsed.data.output === null) {
      return this.invalidProviderOutput(parsed.data, 'Automation provider returned no output.');
    }
    let output: AutomationResult | null = null;
    if (parsed.data.output !== null) {
      const schema =
        expected.kind === 'requirement_split'
          ? splitResultSchema
          : expected.kind === 'task_review'
            ? reviewResultSchema
            : rewriteResultSchema;
      const result = schema.safeParse(parsed.data.output);
      if (!result.success) {
        return this.invalidProviderOutput(
          parsed.data,
          'Automation provider output failed schema validation.',
        );
      }
      output = result.data as AutomationResult;
    }
    return {
      id: parsed.data.id,
      status: parsed.data.status,
      output,
      error: parsed.data.error,
      createdAt: parsed.data.created_at,
      completedAt: parsed.data.completed_at,
    };
  }

  private assertContext(
    run: AutomationRunPayload,
    expected: {
      runId: string | null;
      tenantId: string;
      actorUserId: string;
      kind: AutomationKind;
      correlationId: string;
    },
  ): void {
    if (
      (expected.runId !== null && run.id !== expected.runId) ||
      run.tenant_id !== expected.tenantId ||
      run.actor_user_id !== expected.actorUserId ||
      run.purpose !== purposes[expected.kind] ||
      run.correlation_id !== expected.correlationId ||
      run.output_schema_id !== schemaIds[expected.kind]
    ) {
      throw dependencyUnavailable(
        'Internal automation service returned a run for an unexpected context.',
      );
    }
  }

  private assertStatusInvariant(run: AutomationRunPayload): void {
    const pending = run.status === 'queued' || run.status === 'running';
    const valid = pending
      ? run.output === null && run.error === null && run.completed_at === null
      : run.status === 'succeeded'
        ? run.error === null && run.completed_at !== null
        : run.status === 'failed'
          ? run.output === null && run.error !== null && run.completed_at !== null
          : run.output === null && run.completed_at !== null;
    if (!valid) {
      throw dependencyUnavailable(
        'Internal automation service returned a run with an invalid status payload.',
      );
    }
  }

  private invalidProviderOutput(run: AutomationRunPayload, message: string): AutomationProviderRun {
    return {
      id: run.id,
      status: 'failed',
      output: null,
      error: { code: 'provider_contract_invalid', message },
      createdAt: run.created_at,
      completedAt: run.completed_at,
    };
  }
}
