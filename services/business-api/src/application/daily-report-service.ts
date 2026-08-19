import { randomUUID } from 'node:crypto';

import { badRequest, conflict, forbidden, notFound, versionConflict } from '../domain/errors.js';
import { requireDepartment, requireManager } from '../domain/policies.js';
import type {
  ActorContext,
  AutomationOperation,
  DailyReport,
  DailyReportContent,
  DailyReportStatus,
  DailyRewriteResult,
  Department,
  Page,
  UserSummary,
  UUID,
} from '../domain/models.js';
import type { AutomationPort } from '../ports/automation.js';
import { companyWorkDate, type Clock } from '../ports/clock.js';
import type { BusinessRepository } from '../ports/repository.js';
import { executeIdempotent, paginate, writeAudit, type IdempotentResult } from './shared.js';

export interface DepartmentDailyReportItem {
  user: UserSummary;
  work_date: string;
  report: DailyReport | null;
}

export interface DepartmentDailyReportView {
  department: Department;
  from: string;
  to: string;
  items: DepartmentDailyReportItem[];
  next_cursor: string | null;
}

export class DailyReportService {
  constructor(
    private readonly repository: BusinessRepository,
    private readonly automation: AutomationPort,
    private readonly clock: Clock,
  ) {}

  async list(
    actor: ActorContext,
    filters: {
      from?: string;
      to?: string;
      status?: DailyReportStatus;
      cursor: string | null;
      limit: number;
    },
  ): Promise<Page<DailyReport>> {
    this.assertDateRange(filters.from, filters.to);
    const reports = (await this.repository.listDailyReports(actor.tenantId))
      .filter((report) => report.user_id === actor.userId)
      .filter((report) => filters.from === undefined || report.work_date >= filters.from)
      .filter((report) => filters.to === undefined || report.work_date <= filters.to)
      .filter((report) => filters.status === undefined || report.status === filters.status)
      .filter((report) => filters.status === 'deleted' || report.status !== 'deleted')
      .sort(
        (left, right) =>
          right.work_date.localeCompare(left.work_date) ||
          right.updated_at.localeCompare(left.updated_at),
      );
    return paginate(reports, filters.cursor, filters.limit);
  }

  async get(actor: ActorContext, workDate: string): Promise<DailyReport> {
    const report = await this.repository.getDailyReport(actor.tenantId, actor.userId, workDate);
    if (report === null) throw notFound('Daily report');
    return report;
  }

  async upsert(
    actor: ActorContext,
    workDate: string,
    content: DailyReportContent,
    expectedVersion: number,
  ): Promise<DailyReport> {
    return this.repository.transaction(async () => {
      const departmentId = requireDepartment(actor);
      const existing = await this.repository.getDailyReport(actor.tenantId, actor.userId, workDate);
      const now = this.clock.now().toISOString();
      if (existing === null) {
        if (expectedVersion !== 0) throw versionConflict(0);
        const report: DailyReport = {
          id: randomUUID(),
          tenant_id: actor.tenantId,
          user_id: actor.userId,
          department_id: departmentId,
          work_date: workDate,
          content,
          status: 'draft',
          version: 1,
          published_at: null,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        };
        await this.repository.createDailyReport(report);
        await this.repository.addDailyReportRevision({
          id: randomUUID(),
          report_id: report.id,
          editor_user_id: actor.userId,
          source: 'manual',
          before_content: null,
          after_content: content,
          created_at: now,
        });
        return report;
      }
      if (existing.version !== expectedVersion) throw versionConflict(existing.version);
      const reopened = existing.status === 'deleted';
      const updated: DailyReport = {
        ...existing,
        department_id: departmentId,
        content,
        status: 'draft',
        version: existing.version + 1,
        published_at: null,
        deleted_at: null,
        updated_at: now,
      };
      await this.repository.saveDailyReport(updated, existing.version);
      await this.repository.addDailyReportRevision({
        id: randomUUID(),
        report_id: existing.id,
        editor_user_id: actor.userId,
        source: reopened ? 'reopen' : 'manual',
        before_content: existing.content,
        after_content: content,
        created_at: now,
      });
      return updated;
    });
  }

  async publish(
    actor: ActorContext,
    workDate: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<DailyReport>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /daily-reports/${workDate}/publish`,
      key: idempotencyKey,
      request: { expected_version: expectedVersion },
      statusCode: 200,
      execute: async () => {
        const report = await this.ownedReport(actor, workDate);
        if (report.version !== expectedVersion) throw versionConflict(report.version);
        if (report.status !== 'draft') {
          throw conflict('daily_report_not_publishable', 'Only draft reports can be published.');
        }
        const now = this.clock.now().toISOString();
        const updated: DailyReport = {
          ...report,
          status: 'published',
          version: report.version + 1,
          published_at: now,
          updated_at: now,
        };
        await this.repository.saveDailyReport(updated, report.version);
        await writeAudit({
          repository: this.repository,
          clock: this.clock,
          actor,
          action: 'daily_report.published',
          resourceType: 'daily_report',
          resourceId: report.id,
          details: { work_date: report.work_date },
        });
        return updated;
      },
    });
  }

  async startRewrite(
    actor: ActorContext,
    workDate: string,
    mode: 'polish' | 'shorten' | 'structure',
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<IdempotentResult<AutomationOperation>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /daily-reports/${workDate}/rewrite-runs`,
      key: idempotencyKey,
      request: { mode, expected_version: expectedVersion },
      statusCode: 202,
      execute: async () => {
        const report = await this.ownedReport(actor, workDate);
        if (report.version !== expectedVersion) throw versionConflict(report.version);
        if (report.status === 'deleted') {
          throw conflict('daily_report_deleted', 'Deleted report cannot be rewritten.');
        }
        const providerRun = await this.automation.start({
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          kind: 'daily_rewrite',
          correlationId: report.id,
          input: { mode, content: report.content },
          idempotencyKey,
          requestId: actor.requestId,
        });
        const operation: AutomationOperation = {
          id: randomUUID(),
          kind: 'daily_rewrite',
          actor_user_id: actor.userId,
          resource_type: 'daily_report',
          resource_id: report.id,
          provider: this.automation.provider,
          provider_run_id: providerRun.id,
          status: providerRun.status,
          result: providerRun.output,
          error: providerRun.error,
          version: 1,
          created_at: providerRun.createdAt,
          updated_at: providerRun.createdAt,
          completed_at: providerRun.completedAt,
        };
        await this.repository.createAutomationOperation(operation);
        return operation;
      },
    });
  }

  async applyRewrite(
    actor: ActorContext,
    workDate: string,
    input: { operation_id: UUID; content: DailyReportContent; expected_version: number },
    idempotencyKey: string,
  ): Promise<IdempotentResult<DailyReport>> {
    return executeIdempotent({
      repository: this.repository,
      clock: this.clock,
      actor,
      route: `POST /daily-reports/${workDate}/apply-rewrite`,
      key: idempotencyKey,
      request: input,
      statusCode: 200,
      execute: async () => {
        const report = await this.ownedReport(actor, workDate);
        if (report.version !== input.expected_version) throw versionConflict(report.version);
        const operation = await this.repository.getAutomationOperation(
          actor.tenantId,
          input.operation_id,
        );
        if (
          operation === null ||
          operation.kind !== 'daily_rewrite' ||
          operation.resource_id !== report.id ||
          operation.actor_user_id !== actor.userId ||
          operation.status !== 'succeeded' ||
          operation.result === null
        ) {
          throw conflict(
            'rewrite_operation_not_ready',
            'Rewrite operation is not ready for apply.',
          );
        }
        const result = operation.result as DailyRewriteResult;
        void result;
        const now = this.clock.now().toISOString();
        const updated: DailyReport = {
          ...report,
          content: input.content,
          status: 'draft',
          version: report.version + 1,
          published_at: null,
          updated_at: now,
        };
        await this.repository.saveDailyReport(updated, report.version);
        await this.repository.addDailyReportRevision({
          id: randomUUID(),
          report_id: report.id,
          editor_user_id: actor.userId,
          source: 'ai_rewrite',
          before_content: report.content,
          after_content: input.content,
          created_at: now,
        });
        return updated;
      },
    });
  }

  async delete(actor: ActorContext, workDate: string, expectedVersion: number): Promise<void> {
    await this.repository.transaction(async () => {
      const report = await this.ownedReport(actor, workDate);
      if (report.version !== expectedVersion) throw versionConflict(report.version);
      if (report.status === 'deleted') return;
      const now = this.clock.now().toISOString();
      await this.repository.saveDailyReport(
        {
          ...report,
          status: 'deleted',
          version: report.version + 1,
          deleted_at: now,
          updated_at: now,
        },
        report.version,
      );
      await writeAudit({
        repository: this.repository,
        clock: this.clock,
        actor,
        action: 'daily_report.deleted',
        resourceType: 'daily_report',
        resourceId: report.id,
        details: { work_date: report.work_date },
      });
    });
  }

  async departmentView(
    actor: ActorContext,
    departmentId: UUID,
    filters: {
      date?: string;
      from?: string;
      to?: string;
      member_user_id?: UUID;
      status?: DailyReportStatus;
      cursor: string | null;
      limit: number;
    },
  ): Promise<DepartmentDailyReportView> {
    requireManager(actor, departmentId);
    if (filters.date !== undefined && (filters.from !== undefined || filters.to !== undefined)) {
      throw badRequest('date_range_conflict', 'date cannot be combined with from or to.');
    }
    const today = companyWorkDate(this.clock.now());
    const from = filters.date ?? filters.from ?? filters.to ?? today;
    const to = filters.date ?? filters.to ?? filters.from ?? today;
    this.assertDateRange(from, to);
    const department = await this.repository.getDepartment(actor.tenantId, departmentId);
    if (department === null) throw notFound('Department');
    let users = await this.repository.listDepartmentUsers(actor.tenantId, departmentId);
    if (filters.member_user_id !== undefined) {
      users = users.filter((user) => user.id === filters.member_user_id);
      if (users.length === 0) throw notFound('Department member');
    }
    const reports = await this.repository.listDailyReports(actor.tenantId);
    const byUserDate = new Map(
      reports
        .filter((report) => report.department_id === departmentId)
        .map((report) => [`${report.user_id}:${report.work_date}`, report]),
    );
    const items: DepartmentDailyReportItem[] = [];
    for (const workDate of this.dateRange(from, to).reverse()) {
      for (const user of users.sort((left, right) => left.id.localeCompare(right.id))) {
        const report = byUserDate.get(`${user.id}:${workDate}`) ?? null;
        if (filters.status !== undefined && report?.status !== filters.status) continue;
        items.push({ user, work_date: workDate, report });
      }
    }
    const page = paginate(items, filters.cursor, filters.limit);
    return { department, from, to, items: page.items, next_cursor: page.next_cursor };
  }

  private async ownedReport(actor: ActorContext, workDate: string): Promise<DailyReport> {
    const report = await this.repository.getDailyReport(actor.tenantId, actor.userId, workDate);
    if (report === null) throw notFound('Daily report');
    if (report.user_id !== actor.userId) throw forbidden();
    return report;
  }

  private assertDateRange(from?: string, to?: string): void {
    if (from !== undefined && to !== undefined && from > to) {
      throw badRequest('invalid_date_range', 'from must be before or equal to to.');
    }
    if (from !== undefined && to !== undefined && this.dateRange(from, to).length > 366) {
      throw badRequest('date_range_too_large', 'Date range cannot exceed 366 days.');
    }
  }

  private dateRange(from: string, to: string): string[] {
    const dates: string[] = [];
    const current = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (current <= end && dates.length <= 367) {
      dates.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }
}
