import type {
  AutomationKind,
  AutomationResult,
  AutomationRunStatus,
  UUID,
} from '../domain/models.js';

export interface StartAutomationInput {
  tenantId: UUID;
  actorUserId: UUID;
  kind: AutomationKind;
  correlationId: UUID;
  input: Record<string, unknown>;
  idempotencyKey: string;
  requestId: string;
}

export interface AutomationProviderRun {
  id: UUID;
  status: AutomationRunStatus;
  output: AutomationResult | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AutomationPort {
  readonly provider: 'fake' | 'dsh';
  start(input: StartAutomationInput): Promise<AutomationProviderRun>;
  get(runId: UUID, requestId: string, kind: AutomationKind): Promise<AutomationProviderRun>;
}
