ALTER TABLE business.daily_reports
  ADD COLUMN scope text NOT NULL DEFAULT 'department',
  ADD COLUMN task_id uuid REFERENCES business.tasks(id);

ALTER TABLE business.daily_reports
  ADD CONSTRAINT daily_reports_scope_check
    CHECK (scope IN ('personal', 'department', 'company', 'task')),
  ADD CONSTRAINT daily_reports_task_scope_check
    CHECK ((scope = 'task') = (task_id IS NOT NULL));

ALTER TABLE business.daily_reports
  DROP CONSTRAINT daily_reports_tenant_id_user_id_work_date_key;

CREATE UNIQUE INDEX daily_reports_tenant_user_date_scope_uq
  ON business.daily_reports (tenant_id, user_id, work_date, scope)
  WHERE task_id IS NULL;

CREATE UNIQUE INDEX daily_reports_tenant_user_date_task_uq
  ON business.daily_reports (tenant_id, user_id, work_date, task_id)
  WHERE scope = 'task';

CREATE INDEX daily_reports_task_date_idx
  ON business.daily_reports (task_id, work_date DESC)
  WHERE task_id IS NOT NULL;
