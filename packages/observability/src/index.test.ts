import { describe, expect, it } from 'vitest';

import { REDACTED, redactSensitiveFields } from './index.js';

describe('redactSensitiveFields', () => {
  it('redacts credentials recursively without changing safe audit details', () => {
    expect(
      redactSensitiveFields({
        user_id: 'user-a',
        request: { api_key: 'sk-secret', model: 'model-a' },
        password: 'secret-password',
      }),
    ).toEqual({
      user_id: 'user-a',
      request: { api_key: REDACTED, model: 'model-a' },
      password: REDACTED,
    });
  });
});
