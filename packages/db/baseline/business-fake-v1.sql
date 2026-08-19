-- Development/test profile only. Production migration jobs must never include
-- this file. The fake provider may also run directly from fixture-v1.json.

CREATE TABLE business.fake_knowledge_documents (
  id uuid PRIMARY KEY,
  fixture_key text NOT NULL UNIQUE,
  knowledge_id text NOT NULL UNIQUE,
  owner_user_id uuid REFERENCES platform.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('company', 'personal')),
  category text CHECK (category IN ('company-information', 'xiaopai-design', 'patent-document')),
  title text NOT NULL,
  file_name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  status text NOT NULL
    CHECK (status IN ('pending_review', 'ready', 'rejected', 'archived', 'pending_purge', 'purging')),
  content_chunks jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'company' AND owner_user_id IS NULL AND category IS NOT NULL)
    OR (scope = 'personal' AND owner_user_id IS NOT NULL AND category IS NULL))
);
CREATE INDEX fake_knowledge_documents_visibility_idx
  ON business.fake_knowledge_documents (scope, owner_user_id, category, status);

CREATE TABLE business.fake_knowledge_uploads (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES business.fake_knowledge_documents(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  error_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fake_knowledge_uploads_owner_time_idx
  ON business.fake_knowledge_uploads (owner_user_id, created_at DESC);
CREATE INDEX fake_knowledge_uploads_status_idx ON business.fake_knowledge_uploads (status, updated_at);
