import { describe, expect, it } from 'vitest';

import { validateExternalBaseUrl } from './security.js';

describe('validateExternalBaseUrl', () => {
  it('allows only an exact explicitly configured private authority', async () => {
    const allowedAuthorities = new Set(['host.docker.internal:43123']);

    await expect(
      validateExternalBaseUrl('http://host.docker.internal:43123/v1', { allowedAuthorities }),
    ).resolves.toMatchObject({ host: 'host.docker.internal:43123' });
    await expect(
      validateExternalBaseUrl('http://host.docker.internal:43124/v1', { allowedAuthorities }),
    ).rejects.toMatchObject({ code: 'model_url_disallowed' });
  });

  it('does not let the authority allowlist bypass protocol or credential checks', async () => {
    const allowedAuthorities = new Set(['host.docker.internal:43123']);

    await expect(
      validateExternalBaseUrl('file://host.docker.internal:43123/v1', { allowedAuthorities }),
    ).rejects.toMatchObject({ code: 'model_url_protocol' });
    await expect(
      validateExternalBaseUrl('http://user:secret@host.docker.internal:43123/v1', {
        allowedAuthorities,
      }),
    ).rejects.toMatchObject({ code: 'model_url_credentials' });
  });
});
