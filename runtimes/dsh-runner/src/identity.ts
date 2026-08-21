import { createHmac } from 'node:crypto';

export type RunnerIdentity = {
  tenantId: string;
  userId: string;
  runnerId: string;
};

export function deriveRunnerIdentitySecret(
  rootSecret: Uint8Array,
  identity: RunnerIdentity,
): Buffer {
  if (rootSecret.byteLength < 32) {
    throw new Error('Runner identity root secret must contain at least 32 bytes');
  }
  return createHmac('sha256', rootSecret)
    .update('company-dsh-runner-identity-v1\0', 'utf8')
    .update(identity.tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(identity.userId, 'utf8')
    .update('\0', 'utf8')
    .update(identity.runnerId, 'utf8')
    .digest();
}
