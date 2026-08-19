import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonX, Plus, Power, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Field, InlineAlert, Input, Select } from '@company/ui';
import { api, ApiProblem, problemMessage, type Schema } from '../api';
import {
  EmptyState,
  ErrorState,
  formatDateTime,
  LoadingState,
  PageHeader,
} from '../components/common';
import styles from '../workbench.module.css';

const userSchema = z.object({
  username: z.string().trim().min(1),
  display_name: z.string().trim().min(1),
  temporary_password: z.string().min(8, '临时密码至少 8 位'),
  platform_role: z.enum(['admin', 'member']),
});
type UserValues = z.infer<typeof userSchema>;

export function UsersAdminPage() {
  const [status, setStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin-users', status],
    queryFn: () => api.users((status || undefined) as Schema<'UserStatus'> | undefined),
    retry: false,
  });
  const form = useForm<UserValues>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      username: '',
      display_name: '',
      temporary_password: '',
      platform_role: 'member',
    },
  });
  const create = useMutation({
    mutationFn: api.createUser,
    onSuccess: () => {
      setNotice('用户已创建。');
      setShowCreate(false);
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  const update = useMutation({
    mutationFn: ({
      user,
      nextStatus,
    }: {
      user: Schema<'UserAdminView'>;
      nextStatus: Schema<'UserStatus'>;
    }) => api.updateUser(user.id, { status: nextStatus, expected_version: user.version }),
    onSuccess: (_, values) => {
      setNotice(
        values.nextStatus === 'disabled' ? '账号已停用，现有会话将被撤销。' : '账号已启用。',
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (error) => {
      if (error instanceof ApiProblem && error.status === 412) void query.refetch();
    },
  });
  const actionError = create.error ?? update.error;

  return (
    <div className={styles.page}>
      <PageHeader
        title="用户管理"
        description="创建、启停公司账号并查看组织归属。"
        actions={
          <Button
            variant="primary"
            icon={<Plus />}
            onClick={() => setShowCreate((value) => !value)}
          >
            创建用户
          </Button>
        }
      />
      {(notice || actionError) && (
        <InlineAlert title={actionError ? '操作未完成' : '操作完成'}>
          {actionError ? problemMessage(actionError) : notice}
        </InlineAlert>
      )}
      {showCreate && (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>创建用户</h2>
          </div>
          <div className={styles.panelBody}>
            <form
              className={styles.form}
              onSubmit={form.handleSubmit((values) => create.mutate(values))}
            >
              <div className={styles.formGrid}>
                <Field label="用户名">
                  <Input {...form.register('username')} />
                </Field>
                <Field label="显示名称">
                  <Input {...form.register('display_name')} />
                </Field>
                <Field label="临时密码" error={form.formState.errors.temporary_password?.message}>
                  <Input type="password" {...form.register('temporary_password')} />
                </Field>
                <Field label="平台角色">
                  <Select {...form.register('platform_role')}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </Select>
                </Field>
              </div>
              <div className={styles.formFooter}>
                <Button type="button" onClick={() => setShowCreate(false)}>
                  取消
                </Button>
                <Button type="submit" variant="primary" pending={create.isPending}>
                  创建
                </Button>
              </div>
            </form>
          </div>
        </section>
      )}
      <div className={styles.toolbar}>
        <select
          className={styles.compactSelect}
          aria-label="账号状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="disabled">停用</option>
        </select>
        <span className={styles.muted}>{query.data?.items.length ?? 0} 个用户</span>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState title="没有用户记录" description="调整状态筛选或创建用户。" />
      ) : (
        <section className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>平台角色</th>
                  <th>部门角色</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className={styles.tableTitle}>{user.display_name}</div>
                      <span className={styles.muted}>@{user.username}</span>
                    </td>
                    <td>{user.platform_role}</td>
                    <td>{user.department?.org_role ?? '未分配'}</td>
                    <td>
                      <Badge tone={user.status === 'active' ? 'success' : 'error'}>
                        {user.status === 'active' ? '启用' : '停用'}
                      </Badge>
                    </td>
                    <td>
                      <Button
                        variant={user.status === 'active' ? 'danger' : 'secondary'}
                        icon={user.status === 'active' ? <OctagonX /> : <UserCheck />}
                        pending={update.isPending}
                        onClick={() =>
                          update.mutate({
                            user,
                            nextStatus: user.status === 'active' ? 'disabled' : 'active',
                          })
                        }
                      >
                        {user.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </td>
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

const runnerStates: Schema<'RunnerState'>[] = [
  'stopped',
  'starting',
  'ready',
  'busy',
  'idle',
  'stopping',
  'failed',
];

export function RunnersAdminPage() {
  const [state, setState] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin-runners', state],
    queryFn: () => api.runners((state || undefined) as Schema<'RunnerState'> | undefined),
    retry: false,
  });
  const stop = useMutation({
    mutationFn: (runner: Schema<'RunnerView'>) =>
      api.stopRunner(runner.id, { reason: '管理员从 Workbench 停止', grace_period_seconds: 30 }),
    onSuccess: () => {
      setNotice('停止请求已受理。');
      void queryClient.invalidateQueries({ queryKey: ['admin-runners'] });
    },
  });

  return (
    <div className={styles.page}>
      <PageHeader title="Runner 管理" description="查看每用户独立 Runner 状态并发起优雅停止。" />
      {(notice || stop.error) && (
        <InlineAlert title={stop.error ? '停止失败' : '请求已受理'}>
          {stop.error ? problemMessage(stop.error) : notice}
        </InlineAlert>
      )}
      <div className={styles.toolbar}>
        <select
          className={styles.compactSelect}
          aria-label="Runner 状态"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="">全部状态</option>
          {runnerStates.map((value) => (
            <option value={value} key={value}>
              {value}
            </option>
          ))}
        </select>
        <span className={styles.muted}>{query.data?.items.length ?? 0} 个实例</span>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !query.data?.items.length ? (
        <EmptyState
          title="没有 Runner 实例"
          description="fixture-v1 未提供 Runner 记录；真实实例将在用户进入聊天后由 Runner Manager 创建。"
        />
      ) : (
        <section className={styles.panel}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Runner</th>
                  <th>用户</th>
                  <th>状态</th>
                  <th>镜像</th>
                  <th>最后活动</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((runner) => (
                  <tr key={runner.id}>
                    <td className={styles.mono}>{runner.id}</td>
                    <td className={styles.mono}>{runner.user_id}</td>
                    <td>
                      <Badge
                        tone={
                          runner.state === 'failed'
                            ? 'error'
                            : runner.state === 'ready'
                              ? 'success'
                              : 'warning'
                        }
                      >
                        {runner.state}
                      </Badge>
                    </td>
                    <td>{runner.image_version}</td>
                    <td>{formatDateTime(runner.last_activity_at)}</td>
                    <td>
                      <Button
                        variant="danger"
                        icon={<Power />}
                        pending={stop.isPending}
                        disabled={['stopped', 'stopping'].includes(runner.state)}
                        onClick={() => stop.mutate(runner)}
                      >
                        停止
                      </Button>
                    </td>
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
