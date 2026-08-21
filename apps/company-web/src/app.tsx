import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router';
import { AuthBoundary, WorkbenchLayout } from './components/layout';
import { RunnersAdminPage, UsersAdminPage } from './pages/admin';
import { ChatEntryPage } from './pages/chat';
import { DailyReportsPage, DepartmentDailyReportsPage } from './pages/daily-reports';
import { KnowledgePage } from './pages/knowledge';
import { LoginPage } from './pages/login';
import { ModelSettingsPage } from './pages/model-settings';
import { RequirementDetailPage, RequirementsPage } from './pages/requirements';
import { TaskDetailPage, TasksBoardPage } from './pages/tasks';

export const routes = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <AuthBoundary />,
    children: [
      { path: '/chat', element: <ChatEntryPage /> },
      {
        path: '/workbench',
        element: <WorkbenchLayout />,
        children: [
          { index: true, element: <Navigate to="tasks" replace /> },
          { path: 'settings/model', element: <ModelSettingsPage /> },
          { path: 'knowledge/company', element: <KnowledgePage scope="company" /> },
          { path: 'knowledge/personal', element: <KnowledgePage scope="personal" /> },
          { path: 'requirements', element: <RequirementsPage /> },
          { path: 'requirements/:id', element: <RequirementDetailPage /> },
          { path: 'tasks', element: <TasksBoardPage /> },
          { path: 'tasks/:id', element: <TaskDetailPage /> },
          { path: 'daily-reports', element: <DailyReportsPage /> },
          { path: 'daily-reports/department', element: <DepartmentDailyReportsPage /> },
          { path: 'admin/users', element: <UsersAdminPage /> },
          { path: 'admin/runners', element: <RunnersAdminPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/workbench" replace /> },
];

export const router = createBrowserRouter(routes);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
