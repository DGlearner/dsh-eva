import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, Check, History, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
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

const formSchema = z.object({ body: z.string().max(20_000, '日报正文不能超过 20000 字') });
type FormValues = z.infer<typeof formSchema>;
type ReportScope = Schema<'DailyReportScope'>;
type ReportSelector = { scope: ReportScope; task_id?: string };

const reportStatus: Record<Schema<'DailyReportStatus'>, string> = {
  draft: '草稿',
  published: '已提交',
  deleted: '已删除',
};
const scopeLabel: Record<ReportScope, string> = {
  personal: '个人日报',
  department: '部门日报',
  company: '公司日报',
  task: '任务日报',
};

function reportText(content: Schema<'DailyReportContent'>): string {
  if (content.free_text?.trim()) return content.free_text.trim();
  const sections: Array<[string, string]> = [
    ['今日完成', content.completed_today],
    ['下一步计划', content.next_plan],
    ['阻塞 / 风险', content.blockers],
    ['其他说明', content.other],
  ];
  return sections
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value}`)
    .join('\n');
}

function reportContent(body: string): Schema<'DailyReportContent'> {
  return {
    completed_today: '',
    next_plan: '',
    blockers: '',
    other: '',
    free_text: body,
  };
}

export function DailyReportsPage() {
  const [searchParams] = useSearchParams();
  const taskId = searchParams.get('task_id') || null;
  const taskReturnSearch = new URLSearchParams(searchParams);
  taskReturnSearch.delete('task_id');
  const meQuery = useMe();
  const [date, setDate] = useState(companyWorkDate);
  const [scope, setScope] = useState<Exclude<ReportScope, 'task'>>('department');
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<Schema<'DailyReportContent'> | null>(null);
  const [rewriteOperationId, setRewriteOperationId] = useState<string | null>(null);
  const [rewriteSourceRevision, setRewriteSourceRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const availableScopes = useMemo<Array<Exclude<ReportScope, 'task'>>>(() => {
    if (meQuery.data?.user.platform_role === 'admin') {
      return ['personal', 'department', 'company'];
    }
    if (meQuery.data?.department?.org_role === 'manager') return ['personal', 'department'];
    return ['department'];
  }, [meQuery.data]);
  useEffect(() => {
    if (!availableScopes.includes(scope)) setScope(availableScopes[0]!);
  }, [availableScopes, scope]);

  const selector = useMemo<ReportSelector>(
    () => (taskId ? { scope: 'task', task_id: taskId } : { scope }),
    [scope, taskId],
  );
  const selectorKey = `${selector.scope}:${selector.task_id ?? ''}`;
  const task = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.task(taskId!),
    enabled: Boolean(taskId),
    retry: false,
  });
  const reports = useQuery({
    queryKey: ['daily-reports', selectorKey, status],
    queryFn: () =>
      api.dailyReports({
        scope: selector.scope,
        task_id: selector.task_id,
        status: (status || undefined) as Schema<'DailyReportStatus'> | undefined,
      }),
    retry: false,
  });
  const report = useQuery({
    queryKey: ['daily-report', date, selectorKey],
    queryFn: () => api.dailyReport(date, selector),
    retry: false,
  });
  const missing = report.error instanceof ApiProblem && report.error.status === 404;
  const reportRevision = report.data
    ? `${selectorKey}:${date}:${report.data.id}:${report.data.version}:${report.data.status}`
    : `${selectorKey}:${date}:missing`;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { body: '' },
  });

  useEffect(() => {
    if (report.data) form.reset({ body: reportText(report.data.content) });
    else if (missing) form.reset({ body: '' });
  }, [form, missing, report.data]);
  useEffect(() => {
    setPreview(null);
    setRewriteOperationId(null);
    setRewriteSourceRevision(null);
    setNotice(null);
  }, [date, selectorKey]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['daily-reports'] });
    void queryClient.invalidateQueries({ queryKey: ['daily-report', date, selectorKey] });
  };
  const save = useMutation({
    mutationFn: ({ body }: FormValues) =>
      api.saveDailyReport(date, selector, {
        content: reportContent(body),
        expected_version: report.data?.version ?? 0,
      }),
    onSuccess: () => {
      setNotice('日报草稿已保存。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void report.refetch();
    },
  });
  const publish = useMutation({
    mutationFn: () => api.publishDailyReport(date, selector, report.data!.version),
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
      api.applyDailyRewrite(date, selector, {
        operation_id: rewriteOperationId!,
        content: preview!,
        expected_version: report.data!.version,
      }),
    onSuccess: (data) => {
      form.reset({ body: reportText(data.content) });
      setPreview(null);
      setRewriteOperationId(null);
      setRewriteSourceRevision(null);
      setNotice('改写已应用为草稿。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void report.refetch();
    },
  });
  useEffect(() => {
    if (!rewriteSourceRevision || rewriteSourceRevision === reportRevision) return;
    apply.reset();
    setPreview(null);
    setRewriteOperationId(null);
    setRewriteSourceRevision(null);
    setNotice('日报内容已更新，旧改写预览已失效。');
  }, [apply, reportRevision, rewriteSourceRevision]);
  const remove = useMutation({
    mutationFn: () => api.deleteDailyReport(date, selector, report.data!.version),
    onSuccess: () => {
      setNotice('日报已删除。');
      form.reset({ body: '' });
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
  const currentLabel = scopeLabel[selector.scope];

  return (
    <div className={styles.page}>
      <PageHeader
        title={currentLabel}
        description={
          taskId
            ? `记录“${task.data?.title ?? '当前任务'}”的当日进展。`
            : '选择日报层级，使用一段正文记录当天进展。'
        }
        actions={
          <>
            {taskId && (
              <Link
                to={`/workbench/tasks/${taskId}${taskReturnSearch.size ? `?${taskReturnSearch.toString()}` : ''}`}
              >
                <Button icon={<ArrowLeft />}>返回任务</Button>
              </Link>
            )}
            {report.data && (
              <Badge tone={report.data.status === 'published' ? 'success' : 'warning'}>
                {reportStatus[report.data.status]}
              </Badge>
            )}
          </>
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
      {!taskId && (
        <div className={styles.reportScopeBar}>
          <div className={styles.segmented} aria-label="日报层级">
            {availableScopes.map((value) => (
              <button
                type="button"
                key={value}
                className={`${styles.segment} ${scope === value ? styles.segmentActive : ''}`}
                onClick={() => setScope(value)}
              >
                {scopeLabel[value]}
              </button>
            ))}
          </div>
          <span className={styles.muted}>
            {meQuery.data?.user.platform_role === 'admin'
              ? '公司领导权限'
              : meQuery.data?.department?.org_role === 'manager'
                ? '部门主管权限'
                : '部门员工权限'}
          </span>
        </div>
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
          <Panel
            title={missing ? `${date} · 新建${currentLabel}` : `${date} · 编辑${currentLabel}`}
          >
            <form
              className={`${styles.form} ${styles.reportForm}`}
              onSubmit={form.handleSubmit((values) => {
                if (!hasPendingRewrite && !hasReportMutation) save.mutate(values);
              })}
            >
              <Field
                label="日报正文"
                error={form.formState.errors.body?.message}
                hint={taskId ? '填写这项任务今天的进展、问题和下一步。' : '用一段文字记录即可。'}
              >
                <Textarea
                  rows={13}
                  placeholder="记录今天完成的工作、遇到的问题和接下来的安排…"
                  {...form.register('body')}
                />
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
                      api.rewriteDailyReport(date, selector, {
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
            {preview && (
              <section className={styles.preview}>
                <h3>AI 改写预览</h3>
                <p className={styles.reportPreviewText}>
                  {reportText(preview) || '改写结果为空。'}
                </p>
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
            )}
            <Panel
              title={`${currentLabel}历史`}
              actions={
                <span className={styles.panelTitleIcon}>
                  <History aria-hidden="true" />
                </span>
              }
            >
              {reports.isLoading ? (
                <LoadingState rows={3} />
              ) : reports.error ? (
                <ErrorState error={reports.error} retry={() => void reports.refetch()} />
              ) : reports.data?.items.length ? (
                <ul className={styles.historyList}>
                  {reports.data.items.map((item) => (
                    <li key={item.id}>
                      <button
                        className={styles.historyItem}
                        onClick={() => setDate(item.work_date)}
                      >
                        <span className={styles.historyDate}>
                          <CalendarDays aria-hidden="true" />
                          {item.work_date}
                        </span>
                        <Badge tone={item.status === 'published' ? 'success' : 'warning'}>
                          {reportStatus[item.status]}
                        </Badge>
                        <span className={styles.historySummary}>
                          {reportText(item.content) || '暂无正文'}
                        </span>
                      </button>
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
      <PageHeader title="部门日报" description="按日期查看本部门成员提交的部门日报。" />
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
        <EmptyState title="没有部门日报记录" description="调整日期或成员筛选。" />
      ) : (
        <section className={styles.reports} aria-label="部门日报列表">
          {query.data.items.map((item) => (
            <article className={styles.reportRow} key={`${item.user.id}-${item.work_date}`}>
              <div className={styles.reportPerson}>
                <span className={styles.reportAvatar} aria-hidden="true">
                  {item.user.display_name.slice(0, 1)}
                </span>
                <span>
                  <strong>{item.user.display_name}</strong>
                  <span className={styles.muted}>{item.work_date}</span>
                </span>
              </div>
              {item.report ? (
                <p className={styles.reportBodyText}>
                  {reportText(item.report.content) || '暂无正文'}
                </p>
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
        </section>
      )}
    </div>
  );
}
