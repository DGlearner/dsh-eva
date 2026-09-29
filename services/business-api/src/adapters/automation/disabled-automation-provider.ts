import { dependencyUnavailable } from '../../domain/errors.js';
import type {
  AutomationPort,
  AutomationProviderRun,
  GetAutomationInput,
  StartAutomationInput,
} from '../../ports/automation.js';

export class DisabledAutomationProvider implements AutomationPort {
  // A disabled provider never creates a persisted operation, so the stored provider enum is unused.
  readonly provider = 'model' as const;

  async start(_input: StartAutomationInput): Promise<AutomationProviderRun> {
    throw dependencyUnavailable(
      'Automation is disabled until a production executor is configured.',
    );
  }

  async get(_input: GetAutomationInput): Promise<AutomationProviderRun> {
    throw dependencyUnavailable(
      'Automation is disabled until a production executor is configured.',
    );
  }
}
