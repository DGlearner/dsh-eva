import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { deriveRunnerIdentitySecret } from '@company/dsh-runner';

import type { RunnerContainerSpec } from './domain.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RunnerResourceTemplateOptions = {
  image: string;
  imageVersion: string;
  dataRoot: string;
  runnerIdentityRootSecret: Uint8Array;
  agentToolGatewayUrl: string;
  ingressNetworkName?: string;
  egressNetworkName?: string;
  internalPort?: number;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
};

export class RunnerResourceTemplate {
  private readonly dataRoot: string;

  constructor(private readonly options: RunnerResourceTemplateOptions) {
    if (!options.image || !options.imageVersion)
      throw new Error('Runner image and version are required');
    validateAgentToolGatewayUrl(options.agentToolGatewayUrl);
    this.dataRoot = resolve(options.dataRoot);
  }

  async create(input: {
    runnerId: string;
    tenantId: string;
    userId: string;
    configVersion: number;
  }): Promise<RunnerContainerSpec> {
    for (const [name, value] of Object.entries({
      runnerId: input.runnerId,
      tenantId: input.tenantId,
      userId: input.userId,
    })) {
      if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
    }
    if (!Number.isInteger(input.configVersion) || input.configVersion < 1) {
      throw new Error('configVersion must be a positive integer');
    }
    const userRoot = resolve(this.dataRoot, input.userId);
    if (!userRoot.startsWith(`${this.dataRoot}${sep}`)) {
      throw new Error('Resolved user data path escaped the configured data root');
    }
    const marker = await readActiveMarker(userRoot);
    if (marker.config_version !== input.configVersion) {
      throw new Error('The active Runner configuration version does not match the request');
    }
    const configurationsRoot = resolve(userRoot, 'configurations');
    const userDataPath = resolve(marker.home_path);
    if (!userDataPath.startsWith(`${configurationsRoot}${sep}`)) {
      throw new Error('The active Runner home escaped the user configuration root');
    }
    if (!(await stat(userDataPath)).isDirectory()) {
      throw new Error('The active Runner home is not a directory');
    }
    const sessionsDataPath = resolve(userRoot, 'sessions');
    const workspacesDataPath = resolve(userRoot, 'workspaces');
    const storageDataPath = resolve(userRoot, 'storage');
    await Promise.all(
      [sessionsDataPath, workspacesDataPath, storageDataPath].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );

    return {
      runnerId: input.runnerId,
      tenantId: input.tenantId,
      userId: input.userId,
      image: this.options.image,
      imageVersion: this.options.imageVersion,
      name: `company-dsh-${input.userId}`,
      userDataPath,
      sessionsDataPath,
      workspacesDataPath,
      storageDataPath,
      internalPort: this.options.internalPort ?? 3000,
      ingressNetworkName: this.options.ingressNetworkName ?? 'company-runner',
      egressNetworkName: this.options.egressNetworkName ?? 'company-runner-egress',
      identitySecretBase64: deriveRunnerIdentitySecret(this.options.runnerIdentityRootSecret, {
        tenantId: input.tenantId,
        userId: input.userId,
        runnerId: input.runnerId,
      }).toString('base64'),
      agentToolGatewayUrl: this.options.agentToolGatewayUrl,
      memoryBytes: this.options.memoryBytes ?? 2 * 1024 * 1024 * 1024,
      nanoCpus: this.options.nanoCpus ?? 1_000_000_000,
      pidsLimit: this.options.pidsLimit ?? 256,
    };
  }
}

function validateAgentToolGatewayUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Agent Tool Gateway URL must be a valid absolute URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/internal/v1/agent-tools/query-company-system' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Agent Tool Gateway URL must be HTTP(S) and use /internal/v1/agent-tools/query-company-system',
    );
  }
}

async function readActiveMarker(userRoot: string): Promise<{
  stage_id: string;
  config_version: number;
  home_path: string;
}> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(userRoot, 'active-config.json'), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Runner configuration has not been activated');
    }
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The active Runner configuration marker is invalid');
  }
  const marker = value as Record<string, unknown>;
  if (
    typeof marker.stage_id !== 'string' ||
    !UUID.test(marker.stage_id) ||
    !Number.isInteger(marker.config_version) ||
    (marker.config_version as number) < 1 ||
    typeof marker.home_path !== 'string'
  ) {
    throw new Error('The active Runner configuration marker is invalid');
  }
  return marker as { stage_id: string; config_version: number; home_path: string };
}
