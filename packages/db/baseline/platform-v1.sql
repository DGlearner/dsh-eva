-- Frozen design baseline. core-platform converts this file into forward-only
-- Drizzle migrations; feature branches must not execute or edit it in place.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_name_uq ON platform.tenants (lower(name));

CREATE TABLE platform.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  username text NOT NULL,
  display_name text NOT NULL,
  platform_role text NOT NULL DEFAULT 'member' CHECK (platform_role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_tenant_username_uq ON platform.users (tenant_id, lower(username));
CREATE INDEX users_tenant_status_idx ON platform.users (tenant_id, status);

CREATE TABLE platform.local_password_credentials (
  user_id uuid PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  must_change boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE UNIQUE INDEX web_sessions_token_hash_uq ON platform.web_sessions (token_hash);
CREATE INDEX web_sessions_user_active_idx ON platform.web_sessions (user_id, idle_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_tenant_name_active_uq
  ON platform.departments (tenant_id, lower(name)) WHERE status = 'active';

CREATE TABLE platform.department_members (
  department_id uuid NOT NULL REFERENCES platform.departments(id),
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('manager', 'member')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, user_id),
  UNIQUE (user_id)
);

CREATE TABLE platform.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  hint text,
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX secrets_owner_purpose_active_uq
  ON platform.secrets (owner_user_id, purpose) WHERE revoked_at IS NULL;

CREATE TABLE platform.model_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES platform.users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  model text NOT NULL,
  temperature numeric(3,2) NOT NULL DEFAULT 0.70 CHECK (temperature >= 0 AND temperature <= 2),
  max_output_tokens integer CHECK (max_output_tokens >= 1),
  api_key_secret_id uuid REFERENCES platform.secrets(id),
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.model_config_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  base_version integer NOT NULL CHECK (base_version >= 0),
  config_version integer NOT NULL CHECK (config_version >= 1),
  base_url text NOT NULL,
  model text NOT NULL,
  temperature numeric(3,2) NOT NULL CHECK (temperature >= 0 AND temperature <= 2),
  max_output_tokens integer CHECK (max_output_tokens >= 1),
  api_key_ciphertext bytea,
  api_key_hint text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX model_config_stages_user_pending_uq
  ON platform.model_config_stages(user_id) WHERE state = 'pending';

CREATE TABLE platform.workspaces (
  workspace_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  logical_name text NOT NULL,
  storage_ref text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_user_created_idx ON platform.workspaces (user_id, created_at DESC);

CREATE TABLE platform.sessions (
  session_id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES platform.workspaces(workspace_id),
  title text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'interrupted', 'corrupted')),
  last_event_position bigint CHECK (last_event_position >= 0),
  last_event_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_last_event_idx ON platform.sessions (user_id, last_event_at DESC, session_id);

CREATE TABLE platform.runner_fences (
  user_id uuid PRIMARY KEY REFERENCES platform.users(id) ON DELETE CASCADE,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.runner_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  container_id text,
  image_version text NOT NULL,
  state text NOT NULL DEFAULT 'starting'
    CHECK (state IN ('stopped', 'starting', 'ready', 'busy', 'idle', 'stopping', 'failed')),
  internal_endpoint text,
  config_version integer NOT NULL CHECK (config_version >= 1),
  last_activity_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX runner_instances_container_uq ON platform.runner_instances (container_id)
  WHERE container_id IS NOT NULL;
CREATE UNIQUE INDEX runner_instances_user_primary_uq ON platform.runner_instances (user_id)
  WHERE state IN ('starting', 'ready', 'busy', 'idle', 'stopping');
CREATE INDEX runner_instances_state_idx ON platform.runner_instances (state, updated_at);

CREATE TABLE platform.knowledge_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES platform.tenants(id),
  provider text NOT NULL DEFAULT 'fake' CHECK (provider IN ('fake', 'remote-mcp')),
  remote_mcp_enabled boolean NOT NULL DEFAULT false,
  endpoint text,
  auth_secret_id uuid REFERENCES platform.secrets(id),
  allowed_tools jsonb NOT NULL DEFAULT '["get_current_user","search_knowledge","list_knowledge_documents"]'::jsonb,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT remote_mcp_enabled OR (provider = 'remote-mcp' AND endpoint IS NOT NULL))
);

CREATE TABLE platform.rag_user_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES platform.users(id) ON DELETE CASCADE,
  rag_employee_id text NOT NULL UNIQUE,
  token_secret_id uuid REFERENCES platform.secrets(id),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  actor_user_id uuid NOT NULL REFERENCES platform.users(id),
  route text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response_json jsonb,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor_user_id, route, key)
);
CREATE INDEX idempotency_records_expires_idx ON platform.idempotency_records (expires_at);

CREATE TABLE platform.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform.tenants(id),
  actor_user_id uuid REFERENCES platform.users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  result text NOT NULL,
  request_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_actor_time_idx ON platform.audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_resource_time_idx ON platform.audit_events (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_events_request_idx ON platform.audit_events (request_id);
