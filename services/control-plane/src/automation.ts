import { randomUUID } from 'node:crypto';

export type AutomationPurpose = 'task_split' | 'task_review' | 'daily_rewrite';
export type AutomationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AutomationRun = {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  purpose: AutomationPurpose;
  correlation_id: string;
  status: AutomationStatus;
  output_schema_id: string;
  output: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  created_at: string;
  completed_at: string | null;
};

type CreateAutomationRun = Omit<
  AutomationRun,
  'id' | 'status' | 'output' | 'error' | 'created_at' | 'completed_at'
> & { input: Record<string, unknown> };

export interface AutomationExecutor {
  create(request: CreateAutomationRun): Promise<AutomationRun>;
  get(runId: string): Promise<AutomationRun | null>;
}

export class StubAutomationExecutor implements AutomationExecutor {
  private readonly runs = new Map<string, { run: AutomationRun; reads: number }>();

  async create(request: CreateAutomationRun): Promise<AutomationRun> {
    const run: AutomationRun = {
      id: randomUUID(),
      tenant_id: request.tenant_id,
      actor_user_id: request.actor_user_id,
      purpose: request.purpose,
      correlation_id: request.correlation_id,
      status: 'queued',
      output_schema_id: request.output_schema_id,
      output: null,
      error: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    this.runs.set(run.id, { run, reads: 0 });
    return structuredClone(run);
  }

  async get(runId: string): Promise<AutomationRun | null> {
    const state = this.runs.get(runId);
    if (!state) return null;
    state.reads += 1;
    if (state.reads === 1) {
      state.run.status = 'running';
    } else if (state.run.status !== 'succeeded') {
      state.run.status = 'succeeded';
      state.run.output = this.outputFor(state.run.purpose);
      state.run.completed_at = new Date().toISOString();
    }
    return structuredClone(state.run);
  }

  private outputFor(purpose: AutomationPurpose): Record<string, unknown> {
    if (purpose === 'task_split') {
      return {
        tasks: [
          {
            client_id: 'stub-task-1',
            title: '契约测试任务',
            description: 'StubAutomationExecutor 仅验证内部契约。',
            acceptance_criteria: ['结构化结果可校验'],
            assignee_user_id: null,
            depends_on_client_ids: [],
            position: 1,
          },
        ],
      };
    }
    if (purpose === 'task_review') {
      return {
        result: 'needs_review',
        summary: 'Stub executor requires human review.',
        checks: [],
        evidence: [],
        executor_version: 'stub-contract-v1',
      };
    }
    return {
      content: {
        completed_today: 'Contract stub output.',
        next_plan: '',
        blockers: '',
        other: '',
        free_text: null,
      },
    };
  }
}
