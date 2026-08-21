import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { Button, Field, InlineAlert, Input, LogoSlot } from '@company/ui';
import { api, problemMessage } from '../api';
import styles from '../workbench.module.css';

const schema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  password: z.string().min(8, '密码至少 8 位'),
});

type Values = z.infer<typeof schema>;

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  });
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (context) => {
      queryClient.setQueryData(['me'], context);
      const requested = (location.state as { from?: string } | null)?.from;
      navigate(requested ?? '/workbench/tasks', { replace: true });
    },
  });

  return (
    <main className={styles.loginPage}>
      <section className={styles.loginPanel}>
        <div className={styles.loginBrand}>
          <LogoSlot />
        </div>
        <h1 className={styles.loginTitle}>登录工作台</h1>
        <p className={styles.loginLead}>使用公司账号继续。</p>
        <form
          className={styles.form}
          onSubmit={form.handleSubmit((values) => login.mutate(values))}
        >
          {login.error && <InlineAlert title="登录失败">{problemMessage(login.error)}</InlineAlert>}
          <Field label="用户名" error={form.formState.errors.username?.message}>
            <Input
              autoComplete="username"
              disabled={login.isPending}
              {...form.register('username')}
            />
          </Field>
          <Field label="密码" error={form.formState.errors.password?.message}>
            <Input
              type="password"
              autoComplete="current-password"
              disabled={login.isPending}
              {...form.register('password')}
            />
          </Field>
          <Button type="submit" variant="primary" icon={<LogIn />} pending={login.isPending}>
            登录
          </Button>
        </form>
      </section>
      <aside className={styles.loginAside} aria-hidden="true">
        <div className={styles.loginSignal}>
          <strong>公司协作，一处完成</strong>
          <p>知识、需求、任务与日报保持在清晰的组织边界内。</p>
        </div>
      </aside>
    </main>
  );
}
