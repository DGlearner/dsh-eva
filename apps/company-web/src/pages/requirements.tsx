import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ListTree, Plus, Save, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { z } from 'zod';
import { Badge, Button, Field, InlineAlert, Input, Textarea } from '@company/ui';
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

const requirementSchema = z.object({
  title: z.string().trim().min(1, '请输入标题').max(200),
  objective: z.string().trim().min(1, '请输入目标').max(20_000),
  acceptance: z.string().trim().min(1, '至少填写一条验收条件'),
});
type RequirementValues = z.infer<typeof requirementSchema>;

const requirementStatus: Record<Schema<'RequirementStatus'>, string> = {
  draft: '草稿',
  published: '已发布',
  cancelled: '已取消',
};

export function RequirementsPage() {
  const meQuery = useMe();
  const queryClient = useQueryClient();
  const [view, setView] = useState<'mine' | 'department'>('mine');
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const canManage = meQuery.data?.department?.org_role === 'manager';
  const query = useQuery({
    queryKey: ['requirements', view, status],
    queryFn: () =>
      api.requirements({
        view,
        status: (status || undefined) as Schema<'RequirementStatus'> | undefined,
      }),
    retry: false,
  });
  const form = useForm<RequirementValues>({
    resolver: zodResolver(requirementSchema),
    defaultValues: { title: '', objective: '', acceptance: '' },
  });
  const create = useMutation({
    mutationFn: (values: RequirementValues) =>
      api.createRequirement({
        title: values.title,
        objective: values.objective,
        acceptance_criteria: values.acceptance
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      form.reset();
      setShowCreate(false);
      void queryClient.invalidateQueries({ queryKey: ['requirements'] });
    },
  });

  return (
    <div className={styles.page}>
      <PageHeader
        title="需求管理"
        description="先形成需求草稿和子任务预览，再由主管确认发布。"
        actions={
          <Button
            variant="primary"
            icon={<Plus />}
            disabled={!canManage}
            title={canManage ? '新建需求' : '仅部门主管可发布需求'}
            onClick={() => setShowCreate((value) => !value)}
          >
            新建需求
          </Button>
        }
      />
      {create.error && <InlineAlert title="创建失败">{problemMessage(create.error)}</InlineAlert>}
      {showCreate && (
        <Panel title="新建需求草稿">
          <form
            className={styles.form}
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
          >
            <Field label="标题" error={form.formState.errors.title?.message}>
              <Input {...form.register('title')} />
            </Field>
            <Field label="业务目标" error={form.formState.errors.objective?.message}>
              <Textarea {...form.register('objective')} />
            </Field>
            <Field
              label="验收条件"
              hint="每行一条"
              error={form.formState.errors.acceptance?.message}
            >
              <Textarea {...form.register('acceptance')} />
            </Field>
            <div className={styles.formFooter}>
              <Button type="button" onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" pending={create.isPending}>
                保存草稿
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <div className={styles.toolbar}>
        <div className={styles.segmented} aria-label="需求视图">
          <button
            className={`${styles.segment} ${view === 'mine' ? styles.segmentActive : ''}`}
            onClick={() => setView('mine')}
          >
            我发布的
          </button>
          <button
            className={`${styles.segment} ${view === 'department' ? styles.segmentActive : ''}`}
            onClick={() => setView('department')}
          >
            本部门
          </button>
        </div>
        <select
          className={styles.compactSelect}
          aria-label="需求状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(requirementStatus).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState title="当前视图没有需求" description="调整视图或状态筛选。" />
      ) : (
        <section className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>需求</th>
                  <th>验收项</th>
                  <th>状态</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link className={styles.tableTitle} to={`/workbench/requirements/${item.id}`}>
                        {item.title}
                      </Link>
                      <div className={styles.muted}>{item.objective}</div>
                    </td>
                    <td>{item.acceptance_criteria.length}</td>
                    <td>
                      <Badge
                        tone={
                          item.status === 'published'
                            ? 'success'
                            : item.status === 'cancelled'
                              ? 'error'
                              : 'warning'
                        }
                      >
                        {requirementStatus[item.status]}
                      </Badge>
                    </td>
                    <td>{formatDateTime(item.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

export function RequirementDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<Schema<'RequirementSplitResult'> | null>(null);
  const [splitOperationId, setSplitOperationId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['requirement', id],
    queryFn: () => api.requirement(id),
    retry: false,
  });
  const form = useForm<RequirementValues>({
    resolver: zodResolver(requirementSchema),
    defaultValues: { title: '', objective: '', acceptance: '' },
  });
  useEffect(() => {
    if (!query.data) return;
    form.reset({
      title: query.data.title,
      objective: query.data.objective,
      acceptance: query.data.acceptance_criteria.join('\n'),
    });
  }, [form, query.data]);
  useEffect(() => {
    setPreview(null);
    setSplitOperationId(null);
    setNotice(null);
  }, [id]);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['requirement', id] });
    void queryClient.invalidateQueries({ queryKey: ['requirements'] });
  };
  const update = useMutation({
    mutationFn: (values: RequirementValues) =>
      api.updateRequirement(id, {
        title: values.title,
        objective: values.objective,
        acceptance_criteria: values.acceptance
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        expected_version: query.data!.version,
      }),
    onSuccess: () => {
      setNotice('需求草稿已保存。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const splitAutomation = useAutomationOperation({
    scopeKey: id,
    onSucceeded: (operation) => {
      if (operation.result && 'tasks' in operation.result) {
        setSplitOperationId(operation.id);
        setPreview(operation.result);
        setNotice('需求拆分已完成，请确认预览。');
      } else {
        setNotice('拆分运行未返回预览。');
      }
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applySplit(id, {
        operation_id: splitOperationId!,
        tasks: preview!.tasks,
        expected_version: query.data!.version,
      }),
    onSuccess: () => {
      setPreview(null);
      setSplitOperationId(null);
      setNotice('子任务草稿已应用。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const publish = useMutation({
    mutationFn: () => api.publishRequirement(id, query.data!.version),
    onSuccess: () => {
      setNotice('需求已发布。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });

  if (query.isLoading)
    return (
      <div className={styles.page}>
        <PageHeader title="需求详情" />
        <LoadingState />
      </div>
    );
  if (query.error || !query.data)
    return (
      <div className={styles.page}>
        <PageHeader title="需求详情" />
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  const requirement = query.data;
  const actionError = update.error ?? apply.error ?? publish.error;

  return (
    <div className={styles.page}>
      <PageHeader
        title={requirement.title}
        description={`更新于 ${formatDateTime(requirement.updated_at)}`}
        actions={
          <>
            <Link to="/workbench/requirements">
              <Button icon={<ArrowLeft />}>返回列表</Button>
            </Link>
            <Badge tone={requirement.status === 'published' ? 'success' : 'warning'}>
              {requirementStatus[requirement.status]}
            </Badge>
          </>
        }
      />
      {(notice || actionError) && (
        <InlineAlert title={actionError ? '操作未完成' : '操作完成'}>
          {actionError ? problemMessage(actionError) : notice}
        </InlineAlert>
      )}
      {splitAutomation.isRunning && splitAutomation.operation && (
        <InlineAlert title={`AI 拆分${automationStatusLabel(splitAutomation.operation.status)}`}>
          正在生成子任务预览，请勿重复提交。
        </InlineAlert>
      )}
      {splitAutomation.errorMessage && (
        <InlineAlert title="AI 拆分未完成">{splitAutomation.errorMessage}</InlineAlert>
      )}
      <div className={styles.detailGrid}>
        <Panel title="需求内容">
          <form
            className={styles.form}
            onSubmit={form.handleSubmit((values) => update.mutate(values))}
          >
            <Field label="标题" error={form.formState.errors.title?.message}>
              <Input disabled={requirement.status !== 'draft'} {...form.register('title')} />
            </Field>
            <Field label="业务目标">
              <Textarea disabled={requirement.status !== 'draft'} {...form.register('objective')} />
            </Field>
            <Field label="验收条件" hint="每行一条">
              <Textarea
                disabled={requirement.status !== 'draft'}
                {...form.register('acceptance')}
              />
            </Field>
            {requirement.status === 'draft' && (
              <div className={styles.formFooter}>
                <Button type="submit" icon={<Save />} pending={update.isPending}>
                  保存
                </Button>
                <Button
                  type="button"
                  icon={<ListTree />}
                  pending={splitAutomation.isRunning}
                  onClick={() => {
                    setNotice(null);
                    setPreview(null);
                    setSplitOperationId(null);
                    void splitAutomation.start(() => api.splitRequirement(id, requirement.version));
                  }}
                >
                  AI 拆分
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  icon={<Send />}
                  pending={publish.isPending}
                  disabled={requirement.tasks.length === 0 || splitAutomation.isRunning}
                  onClick={() => publish.mutate()}
                >
                  确认发布
                </Button>
              </div>
            )}
          </form>
        </Panel>
        <div className={styles.stack}>
          <Panel title={`子任务 (${requirement.tasks.length})`}>
            {requirement.tasks.length ? (
              <ul className={styles.plainList}>
                {requirement.tasks.map((task) => (
                  <li key={task.id}>
                    <Link to={`/workbench/tasks/${task.id}`}>{task.title}</Link>{' '}
                    <Badge>{task.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <span className={styles.muted}>尚未应用拆分结果。</span>
            )}
          </Panel>
          {preview && (
            <section className={styles.preview}>
              <h3>拆分预览</h3>
              <ul className={styles.plainList}>
                {preview.tasks.map((task) => (
                  <li key={task.client_id}>
                    <strong>{task.title}</strong>
                    <div className={styles.muted}>{task.description}</div>
                  </li>
                ))}
              </ul>
              <div className={styles.actionRow}>
                <Button
                  variant="primary"
                  icon={<Check />}
                  pending={apply.isPending}
                  disabled={!splitOperationId}
                  onClick={() => apply.mutate()}
                >
                  应用拆分
                </Button>
                <Button
                  onClick={() => {
                    setPreview(null);
                    setSplitOperationId(null);
                  }}
                >
                  放弃
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
