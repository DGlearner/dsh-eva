export type RunnerState =
  'stopped' | 'starting' | 'ready' | 'busy' | 'idle' | 'stopping' | 'failed';
export type RunnerHealth = 'unknown' | 'starting' | 'healthy' | 'unhealthy';

export type RunnerRecord = {
  id: string;
  tenantId: string;
  userId: string;
  containerId: string | null;
  imageVersion: string;
  state: RunnerState;
  health: RunnerHealth;
  internalEndpoint: string | null;
  configVersion: number;
  activeRuns: number;
  leaseExpiresAt: Date | null;
  lastActivityAt: Date | null;
  version: number;
  fencingToken: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RunnerContainerSpec = {
  runnerId: string;
  tenantId: string;
  userId: string;
  image: string;
  imageVersion: string;
  name: string;
  userDataPath: string;
  sessionsDataPath: string;
  workspacesDataPath: string;
  storageDataPath: string;
  internalPort: number;
  ingressNetworkName: string;
  egressNetworkName: string;
  identitySecretBase64: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
};

export type DockerContainerState = {
  containerId: string;
  running: boolean;
  health: RunnerHealth;
  internalEndpoint: string | null;
  internalPort: number;
};

export interface DockerRunnerPort {
  createAndStart(spec: RunnerContainerSpec): Promise<DockerContainerState>;
  inspect(containerId: string): Promise<DockerContainerState | null>;
  stop(containerId: string, gracePeriodSeconds: number): Promise<void>;
  listManaged(): Promise<Array<{ containerId: string; runnerId: string; userId: string }>>;
  remove(containerId: string): Promise<void>;
}

export interface RunnerRepository {
  get(runnerId: string): Promise<RunnerRecord | null>;
  getActiveByUser(userId: string): Promise<RunnerRecord | null>;
  list(): Promise<RunnerRecord[]>;
  create(record: RunnerRecord, fencingToken: number): Promise<void>;
  save(record: RunnerRecord, fencingToken: number): Promise<RunnerRecord>;
}

export class StaleRunnerFenceError extends Error {}

export type Lease = { key: string; holder: string; fencingToken: number; expiresAt: Date };

export interface LeaseStore {
  acquire(key: string, holder: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<Lease | null>;
  release(lease: Lease): Promise<void>;
}
