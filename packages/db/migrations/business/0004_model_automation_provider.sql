ALTER TABLE business.automation_operations
  DROP CONSTRAINT automation_operations_provider_check;

ALTER TABLE business.automation_operations
  ADD CONSTRAINT automation_operations_provider_check
  CHECK (provider IN ('fake', 'model', 'dsh'));
