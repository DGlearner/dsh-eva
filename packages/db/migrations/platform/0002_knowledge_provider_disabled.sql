ALTER TABLE platform.knowledge_provider_configs
  DROP CONSTRAINT knowledge_provider_configs_provider_check;

ALTER TABLE platform.knowledge_provider_configs
  ADD CONSTRAINT knowledge_provider_configs_provider_check
  CHECK (provider IN ('disabled', 'fake', 'remote-mcp'));

ALTER TABLE platform.knowledge_provider_configs
  ALTER COLUMN provider SET DEFAULT 'disabled';
