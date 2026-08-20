import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Field, InlineAlert, Textarea } from '@company/ui';
import { api, ApiProblem, problemMessage, type Schema } from '../api';
import {
  EmptyState,
  ErrorState,
  formatDateTime,
  LoadingState,
  PageHeader,
  Panel,
} from '../components/common';
import { useMe } from '../components/layout';
import { companyWorkDate } from '../date';
import { automationStatusLabel, useAutomationOperation } from '../hooks/use-automation-operation';
import styles from '../workbench.module.css';

const contentSchema = z.object({
  completed_today: z.string().max(20_000),
  next_plan: z.string().max(20_000),
  blockers: z.string().max(20_000),
  other: z.string().max(20_000),
  free_text: z.string().nullable(),
});
type ContentValues = z.infer<typeof contentSchema>;

const emptyContent: ContentValues = {
  completed_today: '',
  next_plan: '',
  blockers: '',
  other: '',
  free_text: null,
};
const reportStatus: Record<Schema<'DailyReportStatus'>, string> = {
  draft: '草稿',
  published: '已提交',
  deleted: '已删除',
};

export function DailyReportsPage() {
  const [date, setDate] = useState(companyWorkDate);
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<Schema<'DailyReportContent'> | null>(null);
  const [rewriteOperationId, setRewriteOperationId] = useState<string | null>(null);
  const [rewriteSourceRevision, setRewriteSourceRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const reports = useQuery({
    queryKey: ['daily-reports', status],
    queryFn: () =>
      api.dailyReports({
        status: (status || undefined) as Schema<'DailyReportStatus'> | undefined,
      }),
    retry: false,
  });
  const report = useQuery({
    queryKey: ['daily-report', date],
    queryFn: () => api.dailyReport(date),
    retry: false,
  });
  const missing = report.error instanceof ApiProblem && report.error.status === 404;
  const reportRevision = report.data
    ? `${date}:${report.data.id}:${report.data.version}:${report.data.status}`
    : `${date}:missing`;
  const form = useForm<ContentValues>({
    resolver: zodResolver(contentSchema),
    defaultValues: emptyContent,
  });
  useEffect(() => {
    if (report.data) form.reset(report.data.content);
    else if (missing) form.reset(emptyContent);
  }, [form, missing, report.data]);
  useEffect(() => {
    setPreview(null);
    setRewriteOperationId(null);
    setRewriteSourceRevision(null);
    setNotice(null);
  }, [date]);
  useEffect(() => {
    if (!rewriteSourceRevision || rewriteSourceRevision === reportRevision) return;
    setPreview(null);
    setRewriteOperationId(null);
    setRewriteSourceRevision(null);
    setNotice('日报内容已更新，旧改写预览已失效。');
  }, [reportRevision, rewriteSourceRevision]);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['daily-reports'] });
    void queryClient.invalidateQueries({ queryKey: ['daily-report', date] });
  };
  const save = useMutation({
    mutationFn: (content: ContentValues) =>
      api.saveDailyReport(date, { content, expected_version: report.data?.version ?? 0 }),
    onSuccess: () => {
      setNotice('日报草稿已保存。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void report.refetch();
    },
  });
  const publish = useMutation({
    mutationFn: () => api.publishDailyReport(date, report.data!.version),
    onSuccess: () => {
      setNotice('日报已提交。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void report.refetch();
    },
  });
  const rewriteAutomation = useAutomationOperation({
    scopeKey: reportRevision,
    onSucceeded: (operation) => {
      if (operation.result && 'content' in operation.result) {
        setRewriteOperationId(operation.id);
        setPreview(operation.result.content);
        setNotice('日报改写已完成，请确认预览。');
        void report.refetch();
      } else {
        setRewriteSourceRevision(null);
        setNotice('改写运行未返回预览。');
      }
    },
  });
  useEffect(() => {
    if (!rewriteAutomation.errorMessage) return;
    setRewriteOperationId(null);
    setRewriteSourceRevision(null);
  }, [rewriteAutomation.errorMessage]);
  const apply = useMutation({
    mutationFn: () =>
      api.applyDailyRewrite(date, {
        operation_id: rewriteOperationId!,
        content: preview!,
        expected_version: report.data!.version,
      }),
    onSuccess: (data) => {
      form.reset(data.content);
      setPreview(null);
      setRewriteOperationId(null);
      setRewriteSourceRevision(null);
      setNotice('改写已应用为草稿。');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDailyReport(date, report.data!.version),
    onSuccess: () => {
      setNotice('日报已软删除。');
      form.reset(emptyContent);
      invalidate();
    },
  });
  const actionError = save.error ?? publish.error ?? apply.error ?? remove.error;
  const hasPendingRewrite = rewriteAutomation.isRunning || Boolean(preview);
  const hasReportMutation =
    save.isPending || publish.isPending || apply.isPending || remove.isPending;
  const canApplyRewrite =
    Boolean(preview) &&
    Boolean(rewriteOperationId) &&
    Boolean(report.data) &&
    report.data?.status !== 'deleted' &&
    rewriteSourceRevision === reportRevision &&
    !rewriteAutomation.isRunning;

  return (
    <div className={styles.page}>
      <PageHeader
        title="我的日报"
        description="按公司时区维护每个工作日的一份日报。"
        actions={
          report.data ? (
            <Badge tone={report.data.status === 'published' ? 'success' : 'warning'}>
              {reportStatus[report.data.status]}
            </Badge>
          ) : undefined
        }
      />
      {(notice || actionError) && (
        <InlineAlert title={actionError ? '操作未完成' : '操作完成'}>
          {actionError ? problemMessage(actionError) : notice}
        </InlineAlert>
      )}
      {rewriteAutomation.isRunning && rewriteAutomation.operation && (
        <InlineAlert title={`日报改写${automationStatusLabel(rewriteAutomation.operation.status)}`}>
          正在生成改写预览，请勿重复提交。
        </InlineAlert>
      )}
      {rewriteAutomation.errorMessage && (
        <InlineAlert title="日报改写未完成">{rewriteAutomation.errorMessage}</InlineAlert>
      )}
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <input
            className={styles.dateInput}
            type="date"
            aria-label="工作日"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <select
            className={styles.compactSelect}
            aria-label="历史状态"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部历史</option>
            {Object.entries(reportStatus).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.muted}>{reports.data?.items.length ?? 0} 条历史记录</span>
      </div>
      {report.isLoading ? (
        <LoadingState />
      ) : report.error && !missing ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : (
        <div className={styles.editor}>
          <Panel title={missing ? `${date} · 新建日报` : `${date} · 编辑日报`}>
            <form
              className={styles.form}
              onSubmit={form.handleSubmit((values) => {
                if (!hasPendingRewrite && !hasReportMutation) save.mutate(values);
              })}
            >
              <Field label="今日完成">
                <Textarea {...form.register('completed_today')} />
              </Field>
              <Field label="下一步计划">
                <Textarea {...form.register('next_plan')} />
              </Field>
              <Field label="阻塞 / 风险">
                <Textarea {...form.register('blockers')} />
              </Field>
              <Field label="其他说明">
                <Textarea {...form.register('other')} />
              </Field>
              <Field label="自由文本">
                <Textarea {...form.register('free_text')} />
              </Field>
              <div className={styles.formFooter}>
                <Button
                  type="submit"
                  disabled={hasPendingRewrite || hasReportMutation}
                  pending={save.isPending}
                >
                  保存草稿
                </Button>
                <Button
                  type="button"
                  icon={<Sparkles />}
                  disabled={
                    !report.data ||
                    report.data.status === 'deleted' ||
                    hasPendingRewrite ||
                    hasReportMutation
                  }
                  pending={rewriteAutomation.isRunning}
                  onClick={() => {
                    if (!report.data || report.data.status === 'deleted' || hasPendingRewrite)
                      return;
                    setNotice(null);
                    setPreview(null);
                    setRewriteOperationId(null);
                    setRewriteSourceRevision(reportRevision);
                    void rewriteAutomation.start(() =>
                      api.rewriteDailyReport(date, {
                        mode: 'polish',
                        expected_version: report.data!.version,
                      }),
                    );
                  }}
                >
                  AI 润色
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  icon={<Check />}
                  disabled={
                    !report.data ||
                    report.data.status === 'deleted' ||
                    hasPendingRewrite ||
                    hasReportMutation
                  }
                  pending={publish.isPending}
                  onClick={() => publish.mutate()}
                >
                  提交日报
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  icon={<Trash2 />}
                  disabled={
                    !report.data ||
                    report.data.status === 'deleted' ||
                    hasPendingRewrite ||
                    hasReportMutation
                  }
                  pending={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  删除
                </Button>
              </div>
            </form>
          </Panel>
          <div className={styles.stack}>
            {preview ? (
              <section className={styles.preview}>
                <h3>AI 改写预览</h3>
                <dl className={styles.definitionList}>
                  <dt>今日完成</dt>
                  <dd>{preview.completed_today}</dd>
                  <dt>下一步</dt>
                  <dd>{preview.next_plan}</dd>
                  <dt>阻塞</dt>
                  <dd>{preview.blockers}</dd>
                  <dt>其他</dt>
                  <dd>{preview.other}</dd>
                </dl>
                <div className={styles.actionRow}>
                  <Button
                    variant="primary"
                    pending={apply.isPending}
                    disabled={!canApplyRewrite}
                    onClick={() => {
                      if (canApplyRewrite) apply.mutate();
                    }}
                  >
                    应用改写
                  </Button>
                  <Button
                    disabled={apply.isPending}
                    onClick={() => {
                      setPreview(null);
                      setRewriteOperationId(null);
                      setRewriteSourceRevision(null);
                    }}
                  >
                    保留原文
                  </Button>
                </div>
              </section>
            ) : null}
            <Panel title="历史日报">
              {reports.isLoading ? (
                <LoadingState rows={3} />
              ) : reports.error ? (
                <ErrorState error={reports.error} retry={() => void reports.refetch()} />
              ) : reports.data?.items.length ? (
                <ul className={styles.plainList}>
                  {reports.data.items.map((item) => (
                    <li key={item.id}>
                      <button className={styles.segment} onClick={() => setDate(item.work_date)}>
                        {item.work_date}
                      </button>{' '}
                      <Badge tone={item.status === 'published' ? 'success' : 'warning'}>
                        {reportStatus[item.status]}
                      </Badge>
                      <div className={styles.muted}>{item.content.completed_today}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.muted}>暂无历史日报。</span>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

export function DepartmentDailyReportsPage() {
  const meQuery = useMe();
  const [date, setDate] = useState(companyWorkDate);
  const [member, setMember] = useState('');
  const [status, setStatus] = useState('');
  const departmentId = meQuery.data?.department?.id ?? '';
  const query = useQuery({
    queryKey: ['department-daily-reports', departmentId, date, member, status],
    queryFn: () =>
      api.departmentDailyReports(departmentId, {
        date,
        member_user_id: member || undefined,
        status: (status || undefined) as Schema<'DailyReportStatus'> | undefined,
      }),
    enabled: Boolean(departmentId),
    retry: false,
  });
  const members = useMemo(() => {
    const map = new Map<string, string>();
    query.data?.items.forEach((item) => map.set(item.user.id, item.user.display_name));
    return [...map.entries()];
  }, [query.data]);

  return (
    <div className={styles.page}>
      <PageHeader title="部门日报" description="查看本部门已提交和未提交成员。" />
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <input
            className={styles.dateInput}
            type="date"
            aria-label="日报日期"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <select
            className={styles.compactSelect}
            aria-label="成员筛选"
            value={member}
            onChange={(event) => setMember(event.target.value)}
          >
            <option value="">全部成员</option>
            {members.map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            className={styles.compactSelect}
            aria-label="日报状态"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">全部状态</option>
            <option value="published">已提交</option>
            <option value="draft">草稿</option>
          </select>
        </div>
        <span className={styles.muted}>{query.data?.department.name}</span>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState title="没有部门日报记录" description="调整日期范围或成员筛选。" />
      ) : (
        <section className={styles.panel}>
          <div className={styles.reports}>
            {query.data.items.map((item) => (
              <article className={styles.reportRow} key={`${item.user.id}-${item.work_date}`}>
                <div>
                  <strong>{item.user.display_name}</strong>
                  <div className={styles.muted}>{item.work_date}</div>
                </div>
                {item.report ? (
                  <div className={styles.reportContent}>
                    <div>
                      <strong>今日完成</strong>
                      <span>{item.report.content.completed_today}</span>
                    </div>
                    <div>
                      <strong>下一步计划</strong>
                      <span>{item.report.content.next_plan}</span>
                    </div>
                    <div>
                      <strong>阻塞 / 风险</strong>
                      <span>{item.report.content.blockers}</span>
                    </div>
                    <div>
                      <strong>其他</strong>
                      <span>{item.report.content.other}</span>
                    </div>
                  </div>
                ) : (
                  <span className={styles.muted}>该成员尚未提交日报。</span>
                )}
                <div>
                  <Badge tone={item.report?.status === 'published' ? 'success' : 'warning'}>
                    {item.report ? reportStatus[item.report.status] : '未提交'}
                  </Badge>
                  {item.report && (
                    <div className={styles.muted}>{formatDateTime(item.report.updated_at)}</div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
