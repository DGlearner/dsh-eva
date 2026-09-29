import fixtureJson from '@company/test-fixtures/fixture-v1';
import type { Schema } from '../api';

type FixtureUser = Schema<'UserSummary'> & { status: Schema<'UserStatus'> };
type FixtureTask = Schema<'TaskSummary'> & {
  department_id: string;
  description: string;
  acceptance_criteria: string[];
};
type Fixture = {
  clock: { now: string; company_timezone: string; work_date: string };
  tenant: { id: string; name: string; status: string };
  departments: Schema<'Department'>[];
  users: FixtureUser[];
  department_members: Schema<'DepartmentMember'>[];
  knowledge: {
    categories: Schema<'KnowledgeCategory'>[];
    documents: Schema<'KnowledgeDocument'>[];
    uploads: Array<Schema<'KnowledgeUpload'> & { owner_user_id: string }>;
  };
  requirements: Schema<'Requirement'>[];
  tasks: FixtureTask[];
  task_dependencies: Array<{ task_id: string; depends_on_task_id: string }>;
  task_submissions: Schema<'TaskSubmission'>[];
  task_review_runs: Array<Schema<'TaskReviewRun'> & { automation_run_id: string }>;
  automation_operations: Array<
    Schema<'AutomationOperation'> & {
      actor_user_id: string;
      resource_type: string;
      resource_id: string;
      provider: string;
    }
  >;
  daily_reports: Schema<'DailyReport'>[];
};

export const fixture = structuredClone(fixtureJson) as unknown as Fixture;

let activeUsername: string | null = null;
let modelConfig: Schema<'ModelConfig'> | null = null;

export function setActiveUsername(username: string | null) {
  activeUsername = username;
}

export function actor(username?: string | null) {
  const selected = username ?? activeUsername;
  return fixture.users.find((user) => user.username === selected) ?? null;
}

export function me(username?: string | null): Schema<'Me'> | null {
  const user = actor(username);
  if (!user) return null;
  const membership = fixture.department_members.find((item) => item.user_id === user.id);
  const department = membership
    ? fixture.departments.find((item) => item.id === membership.department_id)
    : null;
  return {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      platform_role: user.platform_role,
    },
    department:
      membership && department
        ? { id: department.id, name: department.name, org_role: membership.org_role }
        : null,
    csrf_token: 'msw-csrf-token',
  };
}

export function getModelConfig() {
  return modelConfig;
}

export function saveModelConfig(input: Schema<'UpdateModelConfigRequest'>): Schema<'ModelConfig'> {
  const models = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2'];
  const updated: Schema<'ModelConfig'> = {
    base_url: input.base_url,
    model: modelConfig && models.includes(modelConfig.model) ? modelConfig.model : models[0]!,
    models,
    model_count: models.length,
    temperature: modelConfig?.temperature ?? 0.7,
    max_output_tokens: modelConfig?.max_output_tokens ?? null,
    has_api_key: Boolean(input.api_key) || Boolean(modelConfig?.has_api_key),
    api_key_hint: input.api_key
      ? `••••${input.api_key.slice(-4)}`
      : (modelConfig?.api_key_hint ?? null),
    version: (modelConfig?.version ?? 0) + 1,
    updated_at: fixture.clock.now,
  };
  modelConfig = updated;
  return updated;
}

export function resetStore() {
  activeUsername = null;
  modelConfig = null;
}

export function userAdminViews(): Schema<'UserAdminView'>[] {
  return fixture.users.map((user) => ({
    ...user,
    department: fixture.department_members.find((item) => item.user_id === user.id) ?? null,
    version: fixture.department_members.find((item) => item.user_id === user.id)?.version ?? 1,
  }));
}

export function taskDetail(taskId: string): Schema<'TaskDetail'> | null {
  const task = fixture.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  return {
    ...task,
    dependencies: fixture.task_dependencies
      .filter((item) => item.task_id === task.id)
      .map((item) => item.depends_on_task_id),
    submissions: fixture.task_submissions.filter((item) => item.task_id === task.id),
    review_runs: fixture.task_review_runs.filter((item) => item.task_id === task.id),
  };
}

export function requirementDetail(id: string): Schema<'RequirementDetail'> | null {
  const requirement = fixture.requirements.find((item) => item.id === id);
  if (!requirement) return null;
  return {
    ...requirement,
    tasks: fixture.tasks.filter((task) => task.requirement_id === id),
  };
}

export function nextUuid(seed: number) {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}
