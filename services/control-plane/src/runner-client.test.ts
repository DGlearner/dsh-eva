import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunnerManagerHttpClient } from './runner-client.js';

const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const userA = '00000000-0000-4000-8000-000000001003';

afterEach(() => vi.unstubAllGlobals());

describe('RunnerManagerHttpClient', () => {
  it.each([
    ['tenant_id', tenantB],
    ['user_id', '00000000-0000-4000-8000-000000001004'],
    ['config_version', 2],
  ])('rejects an ensure response with mismatched %s ownership', async (field, value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          id: 'runner-a',
          tenant_id: tenantA,
          user_id: userA,
          config_version: 1,
          state: 'ready',
          internal_endpoint: 'http://runner-a:3000',
          [field]: value,
        }),
      ),
    );

    await expect(
      new RunnerManagerHttpClient('http://runner-manager:8081', 'service-token').ensure({
        tenantId: tenantA,
        userId: userA,
        configVersion: 1,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow('non-ready runner');
  });

  it('filters the internal runner roster to the caller tenant', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        items: [
          { id: 'runner-a', tenant_id: tenantA, user_id: userA, state: 'ready' },
          { id: 'runner-b', tenant_id: tenantB, user_id: 'user-b', state: 'ready' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new RunnerManagerHttpClient('http://runner-manager:8081', 'service-token').list(tenantA),
    ).resolves.toEqual([{ id: 'runner-a', tenant_id: tenantA, user_id: userA, state: 'ready' }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://runner-manager:8081/internal/v1/runners',
    );
  });

  it('stops each active runner owned by a disabled user', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return Response.json({
          items: [
            { id: 'runner-active', tenant_id: tenantA, user_id: userA, state: 'ready' },
            { id: 'runner-stopped', tenant_id: tenantA, user_id: userA, state: 'stopped' },
            { id: 'runner-other', tenant_id: tenantA, user_id: 'user-other', state: 'ready' },
          ],
        });
      }
      return Response.json({ operation_id: 'operation-1', status: 'accepted' }, { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await new RunnerManagerHttpClient('http://runner-manager:8081', 'service-token').stopForUser(
      userA,
      'account_disabled',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'http://runner-manager:8081/internal/v1/runners/runner-active/stop',
    );
  });
});
