import { describe, expect, it, vi } from 'vitest';

import { DockerodeRunnerPort } from './docker-wrapper.js';

describe('DockerodeRunnerPort', () => {
  it('health-checks the official DSH Web base path', async () => {
    const start = vi.fn(async () => undefined);
    const createContainer = vi.fn(async (_options: unknown) => ({ id: 'container-1', start }));
    const port = new DockerodeRunnerPort({ createContainer } as never);

    await port.createAndStart({
      name: 'dsh-runner-user-a',
      image: 'company/dsh-runner:test',
      imageVersion: 'test',
      runnerId: '00000000-0000-4000-8000-000000000010',
      tenantId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000001003',
      userDataPath: '/data/dsh-users/user-a',
      sessionsDataPath: '/data/dsh-users/persistent/sessions',
      workspacesDataPath: '/data/dsh-users/persistent/workspaces',
      storageDataPath: '/data/dsh-users/persistent/storage',
      ingressNetworkName: 'company-internal',
      egressNetworkName: 'company-egress',
      identitySecretBase64: Buffer.alloc(32, 9).toString('base64'),
      internalPort: 3000,
      memoryBytes: 1_073_741_824,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
    });

    const options = createContainer.mock.calls[0]?.[0] as {
      Env: string[];
      Healthcheck: { Test: string[] };
      HostConfig: { NetworkMode: string; PortBindings?: unknown };
      NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    expect(options.Healthcheck.Test.join(' ')).toContain('http://127.0.0.1:3000/chat/');
    expect(options.Env).toContain('COMPANY_RUNNER_AUTHORITY=dsh-runner-user-a:3000');
    expect(options.Env).toContain(
      `COMPANY_RUNNER_IDENTITY_SECRET_BASE64=${Buffer.alloc(32, 9).toString('base64')}`,
    );
    expect(options.HostConfig.NetworkMode).toBe('company-internal');
    expect(options.HostConfig.PortBindings).toBeUndefined();
    expect(Object.keys(options.NetworkingConfig.EndpointsConfig)).toEqual([
      'company-internal',
      'company-egress',
    ]);
    expect(start).toHaveBeenCalledOnce();
  });

  it('recovers the internal endpoint from the resource label and requires Docker health data', async () => {
    const inspect = vi.fn(async () => ({
      Name: '/company-dsh-user-a',
      Config: { Labels: { 'company.dsh.internal-port': '4173' } },
      State: { Running: true },
    }));
    const port = new DockerodeRunnerPort({
      getContainer: () => ({ inspect }),
    } as never);

    await expect(port.inspect('container-1')).resolves.toEqual({
      containerId: 'container-1',
      running: true,
      health: 'unknown',
      internalEndpoint: 'http://company-dsh-user-a:4173',
      internalPort: 4173,
    });
  });
});
