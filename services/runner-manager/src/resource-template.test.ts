import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunnerResourceTemplate } from './resource-template.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000001003';
const runnerId = '00000000-0000-4000-8000-000000000010';
const stageId = '00000000-0000-4000-8000-000000000101';

describe('RunnerResourceTemplate', () => {
  it('refuses to create a Docker spec before the requested config version is active', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'runner-template-inactive-'));
    const template = createTemplate(dataRoot);

    await expect(template.create({ runnerId, tenantId, userId, configVersion: 1 })).rejects.toThrow(
      'has not been activated',
    );
  });

  it('uses the versioned home and stable per-user data directories', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'runner-template-active-'));
    const userRoot = join(dataRoot, userId);
    const homePath = join(userRoot, 'configurations', `2-${stageId}`, 'home');
    await mkdir(homePath, { recursive: true });
    await writeFile(
      join(userRoot, 'active-config.json'),
      JSON.stringify({ stage_id: stageId, config_version: 2, home_path: homePath }),
    );
    const template = createTemplate(dataRoot);

    await expect(template.create({ runnerId, tenantId, userId, configVersion: 1 })).rejects.toThrow(
      'does not match',
    );
    await expect(
      template.create({ runnerId, tenantId, userId, configVersion: 2 }),
    ).resolves.toMatchObject({
      name: `company-dsh-${userId}`,
      userDataPath: homePath,
      sessionsDataPath: join(userRoot, 'sessions'),
      workspacesDataPath: join(userRoot, 'workspaces'),
      storageDataPath: join(userRoot, 'storage'),
    });
  });
});

function createTemplate(dataRoot: string) {
  return new RunnerResourceTemplate({
    image: 'company-dsh:test',
    imageVersion: 'test',
    dataRoot,
    runnerIdentityRootSecret: Buffer.alloc(32, 8),
    agentToolGatewayUrl: 'http://control-plane:8080/internal/v1/agent-tools/query-company-system',
  });
}
