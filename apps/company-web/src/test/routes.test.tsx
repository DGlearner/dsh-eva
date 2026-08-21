import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, api } from '../api';
import { handleUnauthorized, queryClient, router, routes } from '../app';
import { AuthBoundary } from '../components/layout';
import { LoginPage } from '../pages/login';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function collectPaths(nodes: typeof routes, parent = ''): string[] {
  return nodes.flatMap((route) => {
    const path = route.path
      ? route.path.startsWith('/')
        ? route.path
        : `${parent}/${route.path}`
      : parent;
    const children =
      'children' in route && route.children
        ? collectPaths(route.children as typeof routes, path)
        : [];
    return route.path ? [path, ...children] : children;
  });
}

describe('Company Workbench route baseline', () => {
  it('declares every route from baseline section 12', () => {
    const paths = collectPaths(routes);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/login',
        '/chat',
        '/workbench',
        '/workbench/settings/model',
        '/workbench/knowledge/company',
        '/workbench/knowledge/personal',
        '/workbench/requirements',
        '/workbench/requirements/:id',
        '/workbench/tasks',
        '/workbench/tasks/:id',
        '/workbench/daily-reports',
        '/workbench/daily-reports/department',
        '/workbench/admin/users',
        '/workbench/admin/runners',
      ]),
    );
  });

  it('renders the login form without network access', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: '登录工作台' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('redirects an unauthenticated deep link to login and preserves the full return path', async () => {
    vi.spyOn(api, 'me').mockRejectedValueOnce(
      new ApiProblem(401, {
        type: 'urn:company-dsh:unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: '请先登录。',
        code: 'unauthorized',
        request_id: 'test-request',
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function LoginLocation() {
      const location = useLocation();
      return <div>return:{(location.state as { from?: string } | null)?.from}</div>;
    }

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/workbench/tasks?view=mine#current']}>
          <Routes>
            <Route path="/login" element={<LoginLocation />} />
            <Route element={<AuthBoundary />}>
              <Route path="/workbench/tasks" element={<h1>任务看板</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('return:/workbench/tasks?view=mine#current')).toBeTruthy();
  });

  it('keeps a service failure on the current route and offers retry', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(
      new ApiProblem(503, {
        type: 'urn:company-dsh:service_unavailable',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Company API 暂时不可用，请稍后重试。',
        code: 'service_unavailable',
        request_id: 'test-request',
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/workbench/tasks']}>
          <Routes>
            <Route path="/login" element={<h1>登录工作台</h1>} />
            <Route element={<AuthBoundary />}>
              <Route path="/workbench/tasks" element={<h1>任务看板</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: '无法加载内容' })).toBeTruthy();
    expect(screen.getByText('Company API 暂时不可用，请稍后重试。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '登录工作台' })).toBeNull();
  });

  it('clears cached identity and routes an expired established session to login', async () => {
    await router.navigate('/workbench/tasks?view=mine#current');
    queryClient.setQueryData(['me'], { csrf_token: 'stale' });

    handleUnauthorized();

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toEqual({
      from: '/workbench/tasks?view=mine#current',
    });
    expect(queryClient.getQueryData(['me'])).toBeUndefined();
  });
});
