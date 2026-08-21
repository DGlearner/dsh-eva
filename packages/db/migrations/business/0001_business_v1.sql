CREATE SCHEMA IF NOT EXISTS business;

CREATE TABLE business.requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  department_id uuid NOT NULL REFERENCES platform.departments(id),
  publisher_user_id uuid NOT NULL REFERENCES platform.users(id),
  title text NOT NULL,
  objective text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requirements_department_status_idx
  ON business.requirements (department_id, status, updated_at DESC);
CREATE INDEX requirements_publisher_idx
  ON business.requirements (publisher_user_id, updated_at DESC);

CREATE TABLE business.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id uuid NOT NULL REFERENCES business.requirements(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES business.tasks(id),
  department_id uuid NOT NULL REFERENCES platform.departments(id),
  assignee_user_id uuid REFERENCES platform.users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'todo', 'in_progress', 'review', 'done', 'failed', 'cancelled')),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  due_at timestamptz,
  latest_review_result text CHECK (latest_review_result IN ('pass', 'fail', 'needs_review')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
CREATE INDEX tasks_requirement_position_idx ON business.tasks (requirement_id, position, id);
CREATE INDEX tasks_assignee_status_idx ON business.tasks (assignee_user_id, status, updated_at DESC);
CREATE INDEX tasks_department_status_idx ON business.tasks (department_id, status, updated_at DESC);

CREATE TABLE business.task_dependencies (
  task_id uuid NOT NULL REFERENCES business.tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES business.tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX task_dependencies_reverse_idx ON business.task_dependencies (depends_on_task_id, task_id);

CREATE TABLE business.task_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES business.tasks(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES platform.users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_status_history_task_time_idx
  ON business.task_status_history (task_id, created_at DESC);

CREATE TABLE business.task_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES business.tasks(id) ON DELETE CASCADE,
  submitter_user_id uuid NOT NULL REFERENCES platform.users(id),
  summary text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_submissions_task_time_idx
  ON business.task_submissions (task_id, created_at DESC);

CREATE TABLE business.automation_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('requirement_split', 'task_review', 'daily_rewrite')),
  actor_user_id uuid NOT NULL REFERENCES platform.users(id),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('fake', 'dsh')),
  provider_run_id uuid,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  result jsonb,
  error jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX automation_operations_provider_run_uq
  ON business.automation_operations (provider_run_id) WHERE provider_run_id IS NOT NULL;
CREATE INDEX automation_operations_resource_time_idx
  ON business.automation_operations (resource_type, resource_id, created_at DESC);

CREATE TABLE business.task_review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES business.tasks(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES business.task_submissions(id) ON DELETE CASCADE,
  automation_run_id uuid NOT NULL UNIQUE REFERENCES business.automation_operations(id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  result text CHECK (result IN ('pass', 'fail', 'needs_review')),
  summary text,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  executor_version text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX task_review_runs_task_time_idx ON business.task_review_runs (task_id, created_at DESC);

CREATE TABLE business.daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  user_id uuid NOT NULL REFERENCES platform.users(id),
  department_id uuid NOT NULL REFERENCES platform.departments(id),
  work_date date NOT NULL,
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deleted')),
  published_at timestamptz,
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, work_date)
);
CREATE INDEX daily_reports_department_date_idx
  ON business.daily_reports (department_id, work_date DESC, status);
CREATE INDEX daily_reports_user_date_idx ON business.daily_reports (user_id, work_date DESC);

CREATE TABLE business.daily_report_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES business.daily_reports(id) ON DELETE CASCADE,
  editor_user_id uuid NOT NULL REFERENCES platform.users(id),
  source text NOT NULL CHECK (source IN ('manual', 'ai_rewrite', 'reopen')),
  before_content jsonb,
  after_content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX daily_report_revisions_report_time_idx
  ON business.daily_report_revisions (report_id, created_at DESC);
