ALTER TABLE platform.model_configs ADD COLUMN models text[];
UPDATE platform.model_configs SET models = ARRAY[model] WHERE models IS NULL;
ALTER TABLE platform.model_configs ALTER COLUMN models SET NOT NULL;
ALTER TABLE platform.model_configs
  ADD CONSTRAINT model_configs_catalog_ck
  CHECK (cardinality(models) > 0 AND model = ANY(models));

ALTER TABLE platform.model_config_stages ADD COLUMN models text[];
UPDATE platform.model_config_stages SET models = ARRAY[model] WHERE models IS NULL;
ALTER TABLE platform.model_config_stages ALTER COLUMN models SET NOT NULL;
ALTER TABLE platform.model_config_stages
  ADD CONSTRAINT model_config_stages_catalog_ck
  CHECK (cardinality(models) > 0 AND model = ANY(models));
