import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  ClipboardCheck,
  Clock3,
  ListTodo,
  NotebookPen,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  UserRound,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useParams } from 'react-router';
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
import { automationStatusLabel, useAutomationOperation } from '../hooks/use-automation-operation';
import styles from '../workbench.module.css';

const boardStatuses: Schema<'TaskStatus'>[] = [
  'planning',
  'todo',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
];
const statusLabel: Record<Schema<'TaskStatus'>, string> = {
  planning: '规划中',
  todo: '待处理',
  in_progress: '进行中',
  review: '待审核',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const views = [
  ['published_by_me', '我发布的'],
  ['assigned_to_me', '分配给我'],
  ['incomplete', '未完成'],
  ['completed', '已完成'],
] as const;

const boardGroups: Array<{
  key: string;
  label: string;
  statuses: Schema<'TaskStatus'>[];
}> = [
  { key: 'backlog', label: '待开始', statuses: ['planning', 'todo'] },
  { key: 'active', label: '进行中', statuses: ['in_progress'] },
  { key: 'review', label: '待审核', statuses: ['review'] },
  { key: 'closed', label: '已结束', statuses: ['done', 'failed', 'cancelled'] },
];

const reviewResultLabel: Record<Schema<'ReviewResult'>, string> = {
  pass: '审核通过',
  fail: '审核未通过',
  needs_review: '需要复核',
};

function reviewTone(value: Schema<'ReviewResult'> | null) {
  if (value === 'pass') return 'success' as const;
  if (value === 'fail') return 'error' as const;
  if (value === 'needs_review') return 'warning' as const;
  return 'neutral' as const;
}

function taskStatusTone(value: Schema<'TaskStatus'>) {
  if (value === 'done') return 'success' as const;
  if (value === 'failed' || value === 'cancelled') return 'error' as const;
  if (value === 'review' || value === 'planning') return 'warning' as const;
  if (value === 'in_progress') return 'info' as const;
  return 'neutral' as const;
}

export function TasksBoardPage() {
  const meQuery = useMe();
  const [view, setView] = useState<(typeof views)[number][0]>('incomplete');
  const [assignee, setAssignee] = useState('');
  const [requirement, setRequirement] = useState('');
  const query = useQuery({
    queryKey: ['tasks', view, assignee, requirement, meQuery.data?.user.id],
    queryFn: () =>
      api.tasks({
        view,
        assignee_user_id:
          assignee ||
          (view === 'incomplete' || view === 'completed' ? meQuery.data?.user.id : undefined),
        requirement_id: requirement || undefined,
      }),
    enabled: Boolean(meQuery.data?.user.id),
    retry: false,
  });
  const requirements = useQuery({
    queryKey: ['requirements', 'department'],
    queryFn: () => api.requirements({ view: 'department' }),
    retry: false,
  });
  const grouped = useMemo(
    () =>
      Object.fromEntries(
        boardStatuses.map((status) => [
          status,
          query.data?.items.filter((item) => item.status === status) ?? [],
        ]),
      ) as Record<Schema<'TaskStatus'>, Schema<'TaskSummary'>[]>,
    [query.data],
  );
  const assignees = useMemo(
    () => [
      ...new Set(
        query.data?.items
          .map((item) => item.assignee_user_id)
          .filter((value): value is string => Boolean(value)) ?? [],
      ),
    ],
    [query.data],
  );
  const total = query.data?.items.length ?? 0;

  return (
    <div className={styles.page}>
      <PageHeader title="任务看板" description="按固定状态跟踪执行、提交与审核进展。" />
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statIcon}>
            <ListTodo aria-hidden="true" />
          </span>
          <div>
            <strong>{total}</strong>
            <span>当前任务</span>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statIcon}>
            <Clock3 aria-hidden="true" />
          </span>
          <div>
            <strong>{grouped.in_progress.length}</strong>
            <span>进行中</span>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={styles.statIcon}>
            <ClipboardCheck aria-hidden="true" />
          </span>
          <div>
            <strong>{grouped.review.length}</strong>
            <span>待审核</span>
          </div>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statIcon} ${styles.statIconWarning}`}>
            <ShieldAlert aria-hidden="true" />
          </span>
          <div>
            <strong>{grouped.failed.length}</strong>
            <span>需处理失败</span>
          </div>
        </div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.segmented} aria-label="任务快速视图">
          {views.map(([value, label]) => (
            <button
              key={value}
              className={`${styles.segment} ${view === value ? styles.segmentActive : ''}`}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.filters}>
          <select
            className={styles.compactSelect}
            aria-label="需求筛选"
            value={requirement}
            onChange={(event) => setRequirement(event.target.value)}
          >
            <option value="">全部需求</option>
            {requirements.data?.items.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <select
            className={styles.compactSelect}
            aria-label="负责人筛选"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="">全部负责人</option>
            {assignees.map((id) => (
              <option value={id} key={id}>
                {id.slice(-4)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {query.isLoading ? (
        <LoadingState rows={7} />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : total === 0 ? (
        <EmptyState title="这个视图没有任务" description="切换快速视图或清除筛选条件。" />
      ) : (
        <section className={styles.board} aria-label="任务状态看板">
          {boardGroups.map((group) => {
            const tasks = group.statuses.flatMap((status) => grouped[status]);
            return (
              <div className={styles.boardColumn} data-phase={group.key} key={group.key}>
                <div className={styles.boardColumnHeader}>
                  <div>
                    <strong>{group.label}</strong>
                    <span>{group.statuses.map((status) => statusLabel[status]).join(' · ')}</span>
                  </div>
                  <Badge>{tasks.length}</Badge>
                </div>
                <div className={styles.taskList}>
                  {tasks.map((task) => {
                    const requirementItem = requirements.data?.items.find(
                      (item) => item.id === task.requirement_id,
                    );
                    return (
                      <Link
                        className={styles.taskCard}
                        to={`/workbench/tasks/${task.id}`}
                        key={task.id}
                      >
                        <span className={styles.taskCardTop}>
                          <Badge tone={taskStatusTone(task.status)}>
                            {statusLabel[task.status]}
                          </Badge>
                          {task.latest_review_result && (
                            <Badge tone={reviewTone(task.latest_review_result)}>
                              {reviewResultLabel[task.latest_review_result]}
                            </Badge>
                          )}
                        </span>
                        <span className={styles.taskCardTitle}>{task.title}</span>
                        <span className={styles.taskRequirement}>
                          {requirementItem?.title ?? task.requirement_id}
                        </span>
                        <span className={styles.taskCardFooter}>
                          <span className={styles.taskMeta}>
                            <UserRound aria-hidden="true" />
                            {task.assignee_user_id
                              ? `成员 ${task.assignee_user_id.slice(-4)}`
                              : '未指派'}
                          </span>
                          <span>
                            <CalendarDays aria-hidden="true" />
                            {task.due_at ? formatDateTime(task.due_at) : '暂无截止时间'}
                          </span>
                          <ChevronRight className={styles.taskArrow} aria-hidden="true" />
                        </span>
                      </Link>
                    );
                  })}
                  {!tasks.length && <span className={styles.boardEmpty}>暂无任务</span>}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

const submissionSchema = z.object({
  summary: z.string().trim().min(1, '请输入提交说明'),
  evidence: z.string().trim().optional(),
});
type SubmissionValues = z.infer<typeof submissionSchema>;

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const meQuery = useMe();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['task', id], queryFn: () => api.task(id), retry: false });
  const form = useForm<SubmissionValues>({
    resolver: zodResolver(submissionSchema),
    defaultValues: { summary: '', evidence: '' },
  });
  useEffect(() => {
    setNotice(null);
    form.reset();
  }, [form, id]);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['task', id] });
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };
  const transition = useMutation({
    mutationFn: (to: Schema<'TaskStatus'>) =>
      api.transitionTask(id, {
        to_status: to,
        reason: null,
        expected_version: query.data!.version,
      }),
    onSuccess: () => {
      setNotice('任务状态已更新。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const submit = useMutation({
    mutationFn: (values: SubmissionValues) =>
      api.submitTask(id, {
        summary: values.summary,
        evidence: values.evidence
          ? [{ kind: 'text', label: '提交证据', value: values.evidence }]
          : [],
        expected_version: query.data!.version,
      }),
    onSuccess: () => {
      form.reset();
      setNotice('结果已提交，任务已进入审核。');
      invalidate();
    },
  });
  const reviewAutomation = useAutomationOperation({
    scopeKey: id,
    onSucceeded: () => {
      setNotice('自动审核已完成，等待主管确认。');
      invalidate();
    },
  });
  const decision = useMutation({
    mutationFn: (action: 'accept' | 'return') =>
      action === 'accept'
        ? api.acceptTask(id, query.data!.version)
        : api.returnTask(id, query.data!.version),
    onSuccess: (_, action) => {
      setNotice(action === 'accept' ? '任务已验收。' : '任务已退回。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });

  if (query.isLoading)
    return (
      <div className={styles.page}>
        <PageHeader title="任务详情" />
        <LoadingState />
      </div>
    );
  if (query.error || !query.data)
    return (
      <div className={styles.page}>
        <PageHeader title="任务详情" />
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  const task = query.data;
  const isManager = meQuery.data?.department?.org_role === 'manager';
  const isAssignee = meQuery.data?.user.id === task.assignee_user_id;
  const canRunReview =
    task.status === 'review' && task.submissions.length > 0 && Boolean(isManager);
  const actionError = transition.error ?? submit.error ?? decision.error;
  const reportSearch = new URLSearchParams(location.search);
  reportSearch.set('task_id', task.id);

  return (
    <div className={styles.page}>
      <PageHeader
        title={task.title}
        description={`更新于 ${formatDateTime(task.updated_at)}`}
        actions={
          <>
            <Link to="/workbench/tasks">
              <Button icon={<ArrowLeft />}>返回看板</Button>
            </Link>
            {isAssignee && task.status !== 'done' && task.status !== 'cancelled' && (
              <Link to={`/workbench/daily-reports?${reportSearch.toString()}`}>
                <Button variant="primary" icon={<NotebookPen />}>
                  填写任务日报
                </Button>
              </Link>
            )}
            <Badge>{statusLabel[task.status]}</Badge>
            {task.latest_review_result && (
              <Badge tone={reviewTone(task.latest_review_result)}>
                最新审核：{task.latest_review_result}
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
      {reviewAutomation.isRunning && reviewAutomation.operation && (
        <InlineAlert title={`自动审核${automationStatusLabel(reviewAutomation.operation.status)}`}>
          正在检查最新提交，请勿重复运行。
        </InlineAlert>
      )}
      {reviewAutomation.errorMessage && (
        <InlineAlert title="自动审核未完成">{reviewAutomation.errorMessage}</InlineAlert>
      )}
      <div className={styles.detailGrid}>
        <div className={styles.stack}>
          <Panel title="任务说明">
            <p>{task.description}</p>
            <h3>验收条件</h3>
            <ul>
              {task.acceptance_criteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <dl className={styles.definitionList}>
              <dt>负责人</dt>
              <dd>{task.assignee_user_id ?? '未指派'}</dd>
              <dt>截止时间</dt>
              <dd>{formatDateTime(task.due_at)}</dd>
              <dt>依赖任务</dt>
              <dd>{task.dependencies.join('、') || '无'}</dd>
            </dl>
          </Panel>
          <Panel title="提交记录">
            {task.submissions.length ? (
              <ul className={styles.plainList}>
                {task.submissions.map((item) => (
                  <li key={item.id}>
                    <strong>{item.summary}</strong>
                    <div className={styles.muted}>{formatDateTime(item.created_at)}</div>
                    {item.evidence.map((entry) => (
                      <div key={`${entry.label}-${entry.value}`}>
                        {entry.label}：{entry.value}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <span className={styles.muted}>尚无提交。</span>
            )}
          </Panel>
          {isAssignee && task.status === 'in_progress' && (
            <Panel title="提交结果">
              <form
                className={styles.form}
                onSubmit={form.handleSubmit((values) => submit.mutate(values))}
              >
                <Field label="提交说明" error={form.formState.errors.summary?.message}>
                  <Textarea {...form.register('summary')} />
                </Field>
                <Field label="证据说明">
                  <Textarea {...form.register('evidence')} />
                </Field>
                <div className={styles.formFooter}>
                  <Button
                    type="submit"
                    variant="primary"
                    icon={<Send />}
                    pending={submit.isPending}
                  >
                    提交结果
                  </Button>
                </div>
              </form>
            </Panel>
          )}
        </div>
        <div className={styles.stack}>
          <Panel title="状态与操作">
            <div className={styles.actionRow}>
              {task.status === 'todo' && (
                <Button
                  icon={<Play />}
                  disabled={!isAssignee}
                  pending={transition.isPending}
                  onClick={() => transition.mutate('in_progress')}
                >
                  开始任务
                </Button>
              )}
              {task.status === 'failed' && (
                <Button
                  icon={<RotateCcw />}
                  disabled={!isAssignee}
                  pending={transition.isPending}
                  onClick={() => transition.mutate('in_progress')}
                >
                  重新处理
                </Button>
              )}
              {task.status === 'review' && (
                <>
                  <Button
                    variant="primary"
                    icon={<CheckCircle2 />}
                    disabled={!isManager}
                    pending={decision.isPending}
                    onClick={() => decision.mutate('accept')}
                  >
                    主管验收
                  </Button>
                  <Button
                    icon={<RotateCcw />}
                    disabled={!isManager}
                    pending={decision.isPending}
                    onClick={() => decision.mutate('return')}
                  >
                    退回
                  </Button>
                </>
              )}
            </div>
            <ul className={styles.timeline}>
              <li>
                <strong>{statusLabel[task.status]}</strong>
                <div className={styles.muted}>{formatDateTime(task.updated_at)} · 当前记录</div>
              </li>
            </ul>
          </Panel>
          <Panel title="自动审核结果">
            {task.review_runs.length ? (
              task.review_runs.map((run) => (
                <div key={run.id} className={styles.stack}>
                  <div className={styles.actionRow}>
                    <Badge tone={reviewTone(run.result)}>{run.result ?? run.status}</Badge>
                    <span className={styles.muted}>{run.executor_version}</span>
                  </div>
                  <p>{run.summary}</p>
                  <table className={styles.reviewChecks}>
                    <tbody>
                      {run.checks.map((check) => (
                        <tr key={check.name}>
                          <td>
                            {check.passed === true ? (
                              <CheckCircle2 color="var(--color-success)" />
                            ) : check.passed === false ? (
                              <XCircle color="var(--color-danger)" />
                            ) : (
                              <CircleDashed />
                            )}
                          </td>
                          <td>
                            <strong>{check.name}</strong>
                            <div className={styles.muted}>{check.detail}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            ) : (
              <span className={styles.muted}>尚未运行自动审核。</span>
            )}
            {canRunReview && (
              <div className={styles.formFooter}>
                <Button
                  icon={<Play />}
                  pending={reviewAutomation.isRunning}
                  onClick={() => {
                    setNotice(null);
                    void reviewAutomation.start(() =>
                      api.reviewTask(id, {
                        submission_id: task.submissions.at(-1)!.id,
                        expected_version: task.version,
                      }),
                    );
                  }}
                >
                  运行自动审核
                </Button>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
