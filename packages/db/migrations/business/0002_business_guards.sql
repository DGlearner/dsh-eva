ALTER TABLE business.automation_operations ADD COLUMN tenant_id uuid;
UPDATE business.automation_operations AS operation
SET tenant_id = users.tenant_id
FROM platform.users AS users
WHERE users.id = operation.actor_user_id;
ALTER TABLE business.automation_operations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE business.automation_operations
  ADD CONSTRAINT automation_operations_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id);
CREATE INDEX automation_operations_tenant_resource_idx
  ON business.automation_operations (tenant_id, resource_type, resource_id, created_at DESC);

CREATE TABLE business.idempotency_records (
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  actor_user_id uuid NOT NULL REFERENCES platform.users(id),
  route text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_user_id, route, key)
);
CREATE INDEX business_idempotency_expires_idx ON business.idempotency_records (expires_at);

CREATE TABLE business.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  actor_user_id uuid NOT NULL REFERENCES platform.users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  request_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_audit_actor_time_idx
  ON business.audit_events (tenant_id, actor_user_id, created_at DESC);
CREATE INDEX business_audit_resource_time_idx
  ON business.audit_events (tenant_id, resource_type, resource_id, created_at DESC);
CREATE INDEX business_audit_request_idx ON business.audit_events (request_id);
