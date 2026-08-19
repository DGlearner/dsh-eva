import { z } from 'zod';

import { dependencyUnavailable } from '../../domain/errors.js';
import type { AutomationKind, AutomationResult } from '../../domain/models.js';
import type {
  AutomationPort,
  AutomationProviderRun,
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
const runSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

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
      input.kind,
    );
  }

  async get(
    runId: string,
    requestId: string,
    kind: AutomationKind,
  ): Promise<AutomationProviderRun> {
    return this.request(
      `/internal/v1/automation-runs/${runId}`,
      requestId,
      { method: 'GET' },
      kind,
    );
  }

  private async request(
    path: string,
    requestId: string,
    init: RequestInit,
    kind?: AutomationKind,
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
    if (!response.ok) {
      throw dependencyUnavailable(`Internal automation service returned ${response.status}.`);
    }
    const parsed = runSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw dependencyUnavailable('Internal automation service returned an invalid run payload.');
    }
    let output: AutomationResult | null = null;
    if (parsed.data.output !== null && kind !== undefined) {
      const schema =
        kind === 'requirement_split'
          ? splitResultSchema
          : kind === 'task_review'
            ? reviewResultSchema
            : rewriteResultSchema;
      const result = schema.safeParse(parsed.data.output);
      if (!result.success) {
        return {
          id: parsed.data.id,
          status: 'failed',
          output: null,
          error: {
            code: 'provider_contract_invalid',
            message: 'Automation provider output failed schema validation.',
          },
          createdAt: parsed.data.created_at,
          completedAt: parsed.data.completed_at,
        };
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
}
