ALTER TABLE business.fake_knowledge_documents ADD COLUMN tenant_id uuid;
UPDATE business.fake_knowledge_documents AS document
SET tenant_id = COALESCE(
  (SELECT users.tenant_id FROM platform.users AS users WHERE users.id = document.owner_user_id),
  (SELECT tenants.id FROM platform.tenants AS tenants ORDER BY tenants.created_at LIMIT 1)
);
ALTER TABLE business.fake_knowledge_documents ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE business.fake_knowledge_documents
  ADD CONSTRAINT fake_knowledge_documents_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id);

ALTER TABLE business.fake_knowledge_uploads ADD COLUMN tenant_id uuid;
UPDATE business.fake_knowledge_uploads AS upload
SET tenant_id = users.tenant_id
FROM platform.users AS users
WHERE users.id = upload.owner_user_id;
ALTER TABLE business.fake_knowledge_uploads ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE business.fake_knowledge_uploads
  ADD CONSTRAINT fake_knowledge_uploads_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES platform.tenants(id);
ALTER TABLE business.fake_knowledge_uploads
  ADD COLUMN scenario text NOT NULL DEFAULT 'success' CHECK (scenario IN ('success', 'fail'));
ALTER TABLE business.fake_knowledge_uploads
  ADD COLUMN poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0);
