import { randomUUID } from 'node:crypto';

import type {
  DailyReportContent,
  DailyRewriteResult,
  RequirementSplitResult,
  TaskReviewAutomationResult,
} from '../../domain/models.js';
import type {
  AutomationPort,
  AutomationProviderRun,
  GetAutomationInput,
  StartAutomationInput,
} from '../../ports/automation.js';
import type { Clock } from '../../ports/clock.js';

interface FakeRun extends AutomationProviderRun {
  polls: number;
  finalOutput: AutomationProviderRun['output'];
  tenantId: string;
  actorUserId: string;
  kind: StartAutomationInput['kind'];
  correlationId: string;
}

export class FakeAutomationProvider implements AutomationPort {
  readonly provider = 'fake' as const;
  private readonly runs = new Map<string, FakeRun>();
  private readonly idempotency = new Map<string, string>();
  private readonly startFailures: Error[] = [];

  constructor(private readonly clock: Clock) {}

  async start(input: StartAutomationInput): Promise<AutomationProviderRun> {
    const failure = this.startFailures.shift();
    if (failure !== undefined) throw failure;
    const identity = `${input.tenantId}:${input.actorUserId}:${input.kind}:${input.correlationId}:${input.idempotencyKey}`;
    const existingId = this.idempotency.get(identity);
    if (existingId !== undefined) return this.publicRun(this.runs.get(existingId)!);

    const now = this.clock.now().toISOString();
    const run: FakeRun = {
      id: randomUUID(),
      status: 'queued',
      output: null,
      error: null,
      createdAt: now,
      completedAt: null,
      polls: 0,
      finalOutput: this.createOutput(input),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      correlationId: input.correlationId,
    };
    this.runs.set(run.id, run);
    this.idempotency.set(identity, run.id);
    return this.publicRun(run);
  }

  failNextStart(error = new Error('Injected automation start failure.')): void {
    this.startFailures.push(error);
  }

  getRunCount(): number {
    return this.runs.size;
  }

  async get(input: GetAutomationInput): Promise<AutomationProviderRun> {
    const run = this.runs.get(input.runId);
    if (run === undefined) {
      return {
        id: input.runId,
        status: 'failed',
        output: null,
        error: { code: 'provider_run_not_found', message: 'Automation run was not found.' },
        createdAt: this.clock.now().toISOString(),
        completedAt: this.clock.now().toISOString(),
      };
    }
    if (
      run.tenantId !== input.tenantId ||
      run.actorUserId !== input.actorUserId ||
      run.kind !== input.kind ||
      run.correlationId !== input.correlationId
    ) {
      return {
        id: input.runId,
        status: 'failed',
        output: null,
        error: {
          code: 'provider_context_mismatch',
          message: 'Automation run context does not match the requested operation.',
        },
        createdAt: run.createdAt,
        completedAt: this.clock.now().toISOString(),
      };
    }
    if (run.status === 'queued') {
      run.polls += 1;
      run.status = 'running';
    } else if (run.status === 'running') {
      run.polls += 1;
      run.status = 'succeeded';
      run.output = run.finalOutput;
      run.completedAt = this.clock.now().toISOString();
    }
    return this.publicRun(run);
  }

  private createOutput(input: StartAutomationInput): AutomationProviderRun['output'] {
    if (input.kind === 'requirement_split') {
      const title = typeof input.input.title === 'string' ? input.input.title : '需求';
      const result: RequirementSplitResult = {
        tasks: [
          {
            client_id: 'split-1',
            title: `实现${title}`.slice(0, 200),
            description: '根据需求目标完成实现并提供可验证证据。',
            acceptance_criteria: Array.isArray(input.input.acceptance_criteria)
              ? input.input.acceptance_criteria.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
            assignee_user_id: null,
            depends_on_client_ids: [],
            position: 1,
          },
        ],
      };
      return result;
    }

    if (input.kind === 'task_review') {
      const evidence = Array.isArray(input.input.evidence)
        ? (input.input.evidence as TaskReviewAutomationResult['evidence'])
        : [];
      const summary = typeof input.input.summary === 'string' ? input.input.summary : '';
      const failed = /失败|fail|error/i.test(summary);
      const result: TaskReviewAutomationResult = {
        result: failed ? 'fail' : evidence.length > 0 ? 'pass' : 'needs_review',
        summary: failed
          ? '提交内容包含失败信号，需要修正后重新提交。'
          : evidence.length > 0
            ? '自动检查通过，仍需主管最终验收。'
            : '证据不足，需要主管人工检查。',
        checks: [
          {
            name: '提交证据',
            passed: failed ? false : evidence.length > 0 ? true : null,
            detail: evidence.length > 0 ? `收到 ${evidence.length} 条证据。` : '未提供证据。',
          },
        ],
        evidence,
        executor_version: 'fake-automation-v1',
      };
      return result;
    }

    const content = input.input.content as DailyReportContent;
    const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
    const result: DailyRewriteResult = {
      content: {
        completed_today: clean(content.completed_today),
        next_plan: clean(content.next_plan),
        blockers: clean(content.blockers),
        other: clean(content.other),
        free_text: content.free_text === null ? null : clean(content.free_text),
      },
    };
    return result;
  }

  private publicRun(run: FakeRun): AutomationProviderRun {
    return {
      id: run.id,
      status: run.status,
      output: run.output,
      error: run.error,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
    };
  }
}
