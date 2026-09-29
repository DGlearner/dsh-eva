import { describe, expect, it } from 'vitest';

import { validatePlatformBootstrapInput } from './bootstrap-platform.js';

describe('Platform bootstrap', () => {
  it('normalizes public fields without trimming the password', () => {
    expect(
      validatePlatformBootstrapInput({
        tenantName: ' Company ',
        username: ' admin ',
        displayName: ' Administrator ',
        password: ' password-with-spaces ',
      }),
    ).toEqual({
      tenantName: 'Company',
      username: 'admin',
      displayName: 'Administrator',
      password: ' password-with-spaces ',
    });
  });

  it('requires the agreed eight-character minimum password', () => {
    expect(() =>
      validatePlatformBootstrapInput({
        tenantName: 'Company',
        username: 'admin',
        displayName: 'Administrator',
        password: '1234567',
      }),
    ).toThrow(/8-128/);
  });
});
