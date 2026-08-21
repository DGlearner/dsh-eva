import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '../app';
import { LoginPage } from '../pages/login';

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
});
