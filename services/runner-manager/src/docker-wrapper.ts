import Docker from 'dockerode';

import type {
  DockerContainerState,
  DockerRunnerPort,
  RunnerContainerSpec,
  RunnerHealth,
} from './domain.js';

function healthFromInspect(inspect: Docker.ContainerInspectInfo): RunnerHealth {
  const status = inspect.State.Health?.Status;
  if (status === 'healthy') return 'healthy';
  if (status === 'starting') return 'starting';
  if (status === 'unhealthy' || inspect.State.Running === false) return 'unhealthy';
  return 'unknown';
}

export class DockerodeRunnerPort implements DockerRunnerPort {
  constructor(private readonly docker: Docker) {}

  async createAndStart(spec: RunnerContainerSpec): Promise<DockerContainerState> {
    const container = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Env: [
        'DSH_HOME=/dsh-user',
        `COMPANY_TENANT_ID=${spec.tenantId}`,
        `COMPANY_USER_ID=${spec.userId}`,
        `COMPANY_RUNNER_ID=${spec.runnerId}`,
        `COMPANY_RUNNER_IDENTITY_SECRET_BASE64=${spec.identitySecretBase64}`,
        `COMPANY_AGENT_TOOL_GATEWAY_URL=${spec.agentToolGatewayUrl}`,
        `COMPANY_RUNNER_AUTHORITY=${spec.name}:${spec.internalPort}`,
        `COMPANY_RUNNER_PORT=${spec.internalPort}`,
      ],
      ExposedPorts: { [`${spec.internalPort}/tcp`]: {} },
      Labels: {
        'company.dsh.managed': 'true',
        'company.dsh.runner-id': spec.runnerId,
        'company.dsh.user-id': spec.userId,
        'company.dsh.internal-port': String(spec.internalPort),
      },
      User: '10001:10001',
      WorkingDir: '/dsh-user/workspaces',
      HostConfig: {
        AutoRemove: false,
        Binds: [
          `${spec.userDataPath}:/dsh-user:rw`,
          `${spec.sessionsDataPath}:/dsh-user/sessions:rw`,
          `${spec.workspacesDataPath}:/dsh-user/workspaces:rw`,
          `${spec.storageDataPath}:/dsh-user/storage:rw`,
        ],
        CapDrop: ['ALL'],
        NetworkMode: spec.ingressNetworkName,
        ExtraHosts: ['host.docker.internal:host-gateway'],
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges:true'],
        Memory: spec.memoryBytes,
        NanoCpus: spec.nanoCpus,
        PidsLimit: spec.pidsLimit,
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,nodev,size=128m,mode=1777',
          '/run': 'rw,noexec,nosuid,nodev,size=16m,mode=755',
        },
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [spec.ingressNetworkName]: {},
          [spec.egressNetworkName]: {},
        },
      },
      Healthcheck: {
        Test: [
          'CMD',
          'node',
          '-e',
          `fetch('http://127.0.0.1:${spec.internalPort}/chat/').then(r=>{if(!r.ok)process.exit(1)})`,
        ],
        Interval: 5_000_000_000,
        Timeout: 2_000_000_000,
        Retries: 12,
        StartPeriod: 5_000_000_000,
      },
    });
    await container.start();
    return {
      containerId: container.id,
      running: true,
      health: 'starting',
      internalEndpoint: `http://${spec.name}:${spec.internalPort}`,
      internalPort: spec.internalPort,
    };
  }

  async inspect(containerId: string): Promise<DockerContainerState | null> {
    try {
      const inspect = await this.docker.getContainer(containerId).inspect();
      const runnerName = inspect.Name.replace(/^\//, '');
      const internalPort = Number(inspect.Config.Labels?.['company.dsh.internal-port']);
      return {
        containerId,
        running: inspect.State.Running,
        health: healthFromInspect(inspect),
        internalEndpoint:
          runnerName && Number.isInteger(internalPort) && internalPort > 0
            ? `http://${runnerName}:${internalPort}`
            : null,
        internalPort: Number.isInteger(internalPort) && internalPort > 0 ? internalPort : 0,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async stop(containerId: string, gracePeriodSeconds: number): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop({ t: gracePeriodSeconds });
    } catch (error) {
      if (![304, 404].includes((error as { statusCode?: number }).statusCode ?? 0)) throw error;
    }
  }

  async listManaged(): Promise<Array<{ containerId: string; runnerId: string; userId: string }>> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ['company.dsh.managed=true'] }),
    });
    return containers.flatMap((container) => {
      const runnerId = container.Labels['company.dsh.runner-id'];
      const userId = container.Labels['company.dsh.user-id'];
      return runnerId && userId ? [{ containerId: container.Id, runnerId, userId }] : [];
    });
  }

  async remove(containerId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerId).remove({ force: true });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }
  }
}
