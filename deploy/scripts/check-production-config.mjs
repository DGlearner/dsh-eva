import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(deployRoot, 'compose.production.yaml');
const envFile = resolve(deployRoot, '.env.production.example');
const output = execFileSync(
  'docker',
  [
    'compose',
    '--env-file',
    envFile,
    '-f',
    composeFile,
    '--profile',
    'ops',
    '--profile',
    'bootstrap',
    'config',
    '--format',
    'json',
  ],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
const config = JSON.parse(output);
const services = config.services ?? {};

for (const forbidden of ['seed-platform', 'seed-business']) {
  invariant(services[forbidden] === undefined, `${forbidden} must not exist in production Compose`);
}

for (const name of ['business-api', 'runner-manager', 'control-plane']) {
  invariant(
    services[name]?.environment?.NODE_ENV === 'production',
    `${name} must run with NODE_ENV=production`,
  );
}

invariant(
  services['business-api']?.environment?.BUSINESS_REPOSITORY === 'postgres',
  'Business API must use PostgreSQL',
);
for (const [service, variable] of [
  ['business-api', 'KNOWLEDGE_PROVIDER'],
  ['business-api', 'AUTOMATION_PROVIDER'],
  ['control-plane', 'KNOWLEDGE_PROVIDER'],
  ['control-plane', 'AUTOMATION_EXECUTOR'],
]) {
  invariant(
    services[service]?.environment?.[variable] !== 'fake' &&
      services[service]?.environment?.[variable] !== 'stub',
    `${service} ${variable} must fail closed instead of using fixtures`,
  );
}

invariant(
  services['migrate-business']?.environment?.BUSINESS_INCLUDE_DEV_MIGRATIONS === 'false',
  'Production Business migrations must exclude development files',
);
invariant(
  String(services.redis?.command ?? '').includes('--appendonly') &&
    String(services.redis?.command ?? '').includes('yes'),
  'Redis AOF persistence must be enabled',
);
invariant(
  (services.redis?.volumes ?? []).some((volume) => volume.target === '/data'),
  'Redis data must use a persistent volume',
);

for (const [name, service] of Object.entries(services)) {
  if (name !== 'gateway') {
    invariant((service.ports ?? []).length === 0, `${name} must not publish host ports`);
  }
  const dockerSocket = (service.volumes ?? []).some(
    (volume) => volume.source === '/var/run/docker.sock',
  );
  invariant(!dockerSocket || name === 'runner-manager', `${name} must not mount the Docker socket`);
}
const gatewayPorts = services.gateway?.ports ?? [];
invariant(gatewayPorts.length === 1, 'Gateway must publish exactly one host port');
invariant(
  gatewayPorts[0]?.host_ip === '127.0.0.1',
  'Gateway must bind only to localhost behind the TLS ingress',
);

process.stdout.write('Production Compose invariants passed.\n');

function invariant(value, message) {
  if (!value) throw new Error(message);
}
