import { describe, expect, it } from 'vitest';

import { deriveRunnerIdentitySecret } from './identity.js';

const identity = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000001003',
  runnerId: '00000000-0000-4000-8000-000000000010',
};

describe('deriveRunnerIdentitySecret', () => {
  it('is stable for one Runner and distinct across Runner identities', () => {
    const root = Buffer.alloc(32, 8);
    const first = deriveRunnerIdentitySecret(root, identity);

    expect(deriveRunnerIdentitySecret(root, identity)).toEqual(first);
    expect(
      deriveRunnerIdentitySecret(root, {
        ...identity,
        runnerId: '00000000-0000-4000-8000-000000000011',
      }),
    ).not.toEqual(first);
  });

  it('rejects a weak root secret', () => {
    expect(() => deriveRunnerIdentitySecret(Buffer.alloc(31), identity)).toThrow(
      'at least 32 bytes',
    );
  });
});
