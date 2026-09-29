import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { IconButton, LogoSlot } from '@company/ui';
import { api, ApiProblem } from '../api';
import { ErrorState, LoadingState } from './common';
import styles from '../workbench.module.css';

type NavigationItem = {
  to: string;
  label: string;
  icon: typeof MessageSquare;
  manager?: boolean;
  admin?: boolean;
};

const navGroups: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: '协作',
    items: [
      { to: '/chat', label: 'AI 对话', icon: MessageSquare },
      { to: '/workbench/tasks', label: '任务看板', icon: LayoutDashboard },
      { to: '/workbench/requirements', label: '需求管理', icon: ClipboardList, manager: true },
    ],
  },
  {
    label: '知识',
    items: [
      { to: '/workbench/knowledge/company', label: '公司知识', icon: BookOpen },
      { to: '/workbench/knowledge/personal', label: '个人知识', icon: FileText },
    ],
  },
  {
    label: '日报',
    items: [
      { to: '/workbench/daily-reports', label: '日报填写', icon: FileText },
      { to: '/workbench/daily-reports/department', label: '部门日报', icon: Users, manager: true },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/workbench/settings/model', label: '模型设置', icon: Settings },
      { to: '/workbench/admin/users', label: '用户管理', icon: Users, admin: true },
      { to: '/workbench/admin/runners', label: 'Runner 管理', icon: Workflow, admin: true },
    ],
  },
];

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 60_000 });
}

export function AuthBoundary() {
  const query = useMe();
  const location = useLocation();
  if (query.isLoading)
    return (
      <main className={styles.content}>
        <LoadingState />
      </main>
    );
  if (query.error instanceof ApiProblem && query.error.status === 401) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    );
  }
  if (query.error)
    return (
      <main className={styles.content}>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </main>
    );
  return <Outlet />;
}

export function WorkbenchLayout() {
  const meQuery = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });
  const context = meQuery.data!;
  const isManager = context.department?.org_role === 'manager';
  const isAdmin = context.user.platform_role === 'admin';
  const crumb =
    navGroups
      .flatMap((group) => group.items)
      .sort((a, b) => b.to.length - a.to.length)
      .find((item) => location.pathname.startsWith(item.to))?.label ?? '工作台';

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <LogoSlot />
        </div>
        <nav className={styles.nav} aria-label="主导航">
          {navGroups.map((group) => {
            const items = group.items.filter(
              (item) => (!item.manager || isManager) && (!item.admin || isAdmin),
            );
            if (!items.length) return null;
            return (
              <div className={styles.navGroup} key={group.label}>
                <p className={styles.navLabel}>{group.label}</p>
                {items.map(({ to, label, icon: Icon }) =>
                  to === '/chat' ? (
                    <a key={to} href={to} className={styles.navLink}>
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </a>
                  ) : (
                    <NavLink
                      key={to}
                      to={to}
                      className={({ isActive }) =>
                        `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                      }
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </NavLink>
                  ),
                )}
              </div>
            );
          })}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.sidebarActions}>
            <div className={styles.identity}>
              <strong>{context.user.display_name}</strong>
              <span>
                {context.department?.name ?? '平台管理'} ·{' '}
                {context.department?.org_role ?? context.user.platform_role}
              </span>
            </div>
            <IconButton
              aria-label="退出登录"
              title="退出登录"
              pending={logout.isPending}
              onClick={() => logout.mutate()}
            >
              <LogOut aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      </aside>
      <main className={styles.main}>
        <header className={styles.topbar}>
          <span className={styles.breadcrumbs}>工作台 / {crumb}</span>
          <div className={styles.topActions}>
            <div className={styles.topIdentity}>
              <strong>{context.user.display_name}</strong>
              <span>{context.department?.name ?? '平台管理'}</span>
            </div>
            <span className={styles.avatar} aria-hidden="true">
              {context.user.display_name.slice(0, 1)}
            </span>
          </div>
        </header>
        <div className={styles.content}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
