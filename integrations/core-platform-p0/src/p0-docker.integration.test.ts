import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeFile = resolve(repositoryRoot, 'integrations/core-platform-p0/compose.yaml');
const suffix = `${process.pid}-${Date.now()}`;
const project = `company-dsh-p0-${suffix}`.replaceAll(/[^a-zA-Z0-9_-]/g, '-');
const ingressNetwork = `${project}-runner-ingress`;
const egressNetwork = `${project}-runner-egress`;
const runnerImage = `${project}-runner:latest`;
const controlPlaneImage = `${project}-control-plane:latest`;
const runnerManagerImage = `${project}-runner-manager:latest`;
const password = 'p0-password-123';
const tenantId = '00000000-0000-4000-8000-000000000001';
const userAId = '00000000-0000-4000-8000-000000001003';
const userBId = '00000000-0000-4000-8000-000000001004';
const dynamicRunnerNames = [`company-dsh-${userAId}`, `company-dsh-${userBId}`];

let dataRoot = '';
let gatewayPort = 0;
let modelServer: Server;
let modelPort = 0;
let dockerGid = '0';
let composeEnvironment: NodeJS.ProcessEnv;
let baseUrl = '';
const modelRequests: Array<Record<string, unknown>> = [];

type Login = { cookie: string; csrf: string };
type RpcValue = Record<string, unknown>;

beforeAll(async () => {
  await command('docker', ['info']);
  await assertContainerNamesAvailable(dynamicRunnerNames);
  dataRoot = await mkdtemp(resolve(tmpdir(), 'company-dsh-p0-'));
  gatewayPort = await availablePort();
  ({ server: modelServer, port: modelPort } = await startModelServer(modelRequests));
  dockerGid = (
    await command('docker', [
      'run',
      '--rm',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      'node:22-alpine',
      'stat',
      '-c',
      '%g',
      '/var/run/docker.sock',
    ])
  ).stdout.trim();
  composeEnvironment = {
    ...process.env,
    P0_CONTROL_PLANE_IMAGE: controlPlaneImage,
    P0_RUNNER_MANAGER_IMAGE: runnerManagerImage,
    P0_RUNNER_IMAGE: runnerImage,
    P0_DATA_ROOT: dataRoot,
    P0_DOCKER_GID: dockerGid,
    P0_INGRESS_NETWORK: ingressNetwork,
    P0_EGRESS_NETWORK: egressNetwork,
    P0_GATEWAY_PORT: String(gatewayPort),
    P0_MODEL_AUTHORITY: `host.docker.internal:${modelPort}`,
  };

  await command('docker', ['pull', 'redis:7-alpine'], { timeoutMs: 180_000 });
  await buildImage(runnerImage, 'runtimes/dsh-runner/Dockerfile');
  await buildImage(controlPlaneImage, 'services/control-plane/Dockerfile');
  await buildImage(runnerManagerImage, 'services/runner-manager/Dockerfile');
  await compose(['up', '-d', '--wait', 'postgres', 'redis']);
  await compose(['--profile', 'ops', 'run', '--rm', 'migrate']);
  await compose([
    '--profile',
    'ops',
    'run',
    '--rm',
    '-e',
    `TEST_SEED_PASSWORD=${password}`,
    'migrate',
    'node',
    'packages/db/dist/seed-platform.js',
  ]);
  await compose(['up', '-d', 'runner-manager', 'control-plane', 'gateway']);
  baseUrl = `http://127.0.0.1:${gatewayPort}`;
  await waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/company-api/v1/me`);
      return response.status === 401;
    },
    60_000,
    'Gateway did not become ready',
  );
}, 900_000);

afterAll(async () => {
  await Promise.all(
    dynamicRunnerNames.map((name) =>
      command('docker', ['rm', '-f', name], { reject: false, timeoutMs: 30_000 }),
    ),
  );
  if (composeEnvironment) {
    await compose(['down', '-v', '--remove-orphans'], { reject: false, timeoutMs: 120_000 });
  }
  await Promise.all([
    closeServer(modelServer),
    dataRoot ? rm(dataRoot, { recursive: true, force: true }) : Promise.resolve(),
  ]);
}, 180_000);

describe('P0 Docker platform boundary', () => {
  it('replaces an expired PostgreSQL automation idempotency record', async () => {
    const key = crypto.randomUUID();
    const first = await createAutomationRun(key, automationBody('task_split'));
    expect(first.status).toBe(202);

    const expired = await postgres(
      `WITH expired AS (UPDATE platform.idempotency_records SET expires_at=now()-interval '1 second' WHERE key='${key}' RETURNING version) SELECT version FROM expired;`,
    );
    expect(expired).toBe('1');

    const replacementBody = automationBody('task_review');
    const replacement = await createAutomationRun(key, replacementBody);
    const duplicate = await createAutomationRun(key, replacementBody);
    expect(replacement.status).toBe(202);
    expect(replacement.body.id).not.toBe(first.body.id);
    expect(duplicate).toEqual(replacement);

    const persisted = await postgres(
      `SELECT count(*) || ':' || min(version) || ':' || min(response_json->>'id') FROM platform.idempotency_records WHERE key='${key}';`,
    );
    expect(persisted).toBe(`1:2:${String(replacement.body.id)}`);
  });

  it('runs two isolated users through real Web, RPC, WebSocket, model, Tool, and recovery', async () => {
    onTestFailed(async () => {
      const logs = await compose(['logs', '--no-color'], { reject: false, timeoutMs: 30_000 });
      process.stderr.write(`\nP0 compose logs:\n${logs.stdout}${logs.stderr}\n`);
    });

    const admin = await login('admin');
    const userA = await login('dev_a');
    const userB = await login('dev_b');
    expect(await fetch(`${baseUrl}/chat`)).toMatchObject({ status: 401 });

    await configureModel(userA);
    await configureModel(userB);

    const [webA, webB] = await Promise.all([openOfficialWeb(userA), openOfficialWeb(userB)]);
    expect(webA).toContain('<title>Company DSH</title>');
    expect(webB).toContain('<title>Company DSH</title>');
    const assetPath = webA.match(/(?:src|href)="(\/chat\/assets\/[^"]+)"/)?.[1];
    expect(assetPath).toBeTruthy();
    const asset = await fetch(`${baseUrl}${assetPath}`, { headers: { cookie: userA.cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect((await asset.text()).startsWith('<!doctype html>')).toBe(false);
    const pluginPath = webA.match(/"url":"(\/chat\/plugins\/[^"]+\/client\.js\?rev=[^"]+)"/)?.[1];
    expect(pluginPath).toBeTruthy();
    const plugin = await fetch(`${baseUrl}${pluginPath}`, { headers: { cookie: userA.cookie } });
    expect(plugin.status).toBe(200);
    expect(plugin.headers.get('content-type')).toContain('text/javascript');

    const runnerA = await inspectRunner(userAId);
    const runnerB = await inspectRunner(userBId);
    assertRunnerIsolation(runnerA, runnerB);
    await assertRunnerCannotCallPeer(runnerA, runnerB);

    const socket = await openEventsSocket(userA.cookie);
    const frames: string[] = [];
    socket.on('message', (data) => frames.push(data.toString()));

    const sessionA1 = String((await rpc(userA, 'session.create', {})).sessionId);
    const sessionA2 = String((await rpc(userA, 'session.create', {})).sessionId);
    const sessionB = String((await rpc(userB, 'session.create', {})).sessionId);
    await Promise.all([
      prompt(userA, sessionA1, '请检索员工出差住宿报销上限'),
      prompt(userA, sessionA2, '请再次检索员工出差住宿报销上限'),
      prompt(userB, sessionB, '请检索员工出差住宿报销上限'),
    ]);

    const histories = await Promise.all([
      waitForHistory(userA, sessionA1),
      waitForHistory(userA, sessionA2),
      waitForHistory(userB, sessionB),
    ]);
    for (const history of histories) assertKnowledgeHistory(history);
    await waitFor(() => frames.length > 0, 30_000, 'No real WebSocket event was received');
    expect(modelRequests.length).toBeGreaterThanOrEqual(6);
    expect(modelRequests.some((request) => request.authorization === 'Bearer p0-fixture-key')).toBe(
      true,
    );

    const crossUser = await rpcResponse(userB, 'session.history', {
      sessionId: sessionA1,
      maxMessages: 100,
    });
    expect(crossUser.status).toBe(404);

    const runners = await api(admin, '/company-api/v1/admin/runners');
    const activeA = (runners.items as Array<Record<string, unknown>>).find(
      (runner) => runner.user_id === userAId && runner.state === 'ready',
    );
    expect(activeA?.id).toEqual(expect.any(String));
    const stopped = await api(admin, `/company-api/v1/admin/runners/${String(activeA?.id)}/stop`, {
      method: 'POST',
      body: { reason: 'p0_rebuild', grace_period_seconds: 5 },
    });
    expect(stopped.status).toBe('accepted');
    await openOfficialWeb(userA);
    const rebuiltA = await inspectRunner(userAId);
    expect(rebuiltA.Id).not.toBe(runnerA.Id);

    const restored = (await rpc(userA, 'session.list', {})).items as Array<Record<string, unknown>>;
    expect(restored.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining([sessionA1, sessionA2]),
    );
    assertKnowledgeHistory(await history(userA, sessionA1));
    assertKnowledgeHistory(await history(userA, sessionA2));

    const disabled = await api(admin, `/company-api/v1/admin/users/${userBId}`, {
      method: 'PATCH',
      body: { status: 'disabled', expected_version: 1 },
    });
    expect(disabled.status).toBe('disabled');
    const revoked = await fetch(`${baseUrl}/company-api/v1/me`, {
      headers: { cookie: userB.cookie },
    });
    expect(revoked.status).toBe(401);
    const deniedRunner = await fetch(`${baseUrl}/chat`, { headers: { cookie: userB.cookie } });
    expect(deniedRunner.status).toBe(401);
    await waitFor(
      async () => !(await containerExists(`company-dsh-${userBId}`)),
      30_000,
      'Disabled user Runner was not removed',
    );

    const databaseChecks = await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'company_dsh',
      '-d',
      'company_dsh',
      '-Atc',
      `select count(*) from platform.sessions where user_id in ('${userAId}','${userBId}');`,
    ]);
    expect(Number(databaseChecks.stdout.trim())).toBeGreaterThanOrEqual(3);
    socket.close();
  });
});

function automationBody(purpose: 'task_split' | 'task_review'): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    actor_user_id: userAId,
    purpose,
    correlation_id: crypto.randomUUID(),
    input: { title: 'P0 idempotency expiry' },
    output_schema_id: `${purpose}.v1`,
  };
}

async function createAutomationRun(
  key: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const script = `
    const body = JSON.parse(process.argv[1]);
    fetch('http://127.0.0.1:8080/internal/v1/automation-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer p0-internal-service-token',
        'content-type': 'application/json',
        'idempotency-key': process.argv[2],
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
    }).catch((error) => {
      process.stderr.write(String(error));
      process.exitCode = 1;
    });
  `;
  const result = await compose([
    'exec',
    '-T',
    'control-plane',
    'node',
    '-e',
    script,
    JSON.stringify(body),
    key,
  ]);
  return JSON.parse(result.stdout) as { status: number; body: Record<string, unknown> };
}

async function postgres(sql: string): Promise<string> {
  const result = await compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'company_dsh',
    '-d',
    'company_dsh',
    '-Atc',
    sql,
  ]);
  return result.stdout.trim();
}

async function configureModel(loginState: Login): Promise<void> {
  const response = await api(loginState, '/company-api/v1/model-config', {
    method: 'PUT',
    body: {
      base_url: `http://host.docker.internal:${modelPort}/v1`,
      model: 'p0-mock-model',
      temperature: 0.2,
      max_output_tokens: 1024,
      api_key: 'p0-fixture-key',
      expected_version: 0,
    },
  });
  expect(response).toMatchObject({ version: 1, has_api_key: true });
}

async function openOfficialWeb(loginState: Login): Promise<string> {
  const response = await fetch(`${baseUrl}/chat`, { headers: { cookie: loginState.cookie } });
  if (!response.ok)
    throw new Error(`Official DSH Web failed: ${response.status} ${await response.text()}`);
  return response.text();
}

async function login(username: string): Promise<Login> {
  const response = await fetch(`${baseUrl}/company-api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`Login failed for ${username}: ${await response.text()}`);
  const value = (await response.json()) as { csrf_token: string };
  const cookies = response.headers.getSetCookie();
  return {
    cookie: cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '),
    csrf: value.csrf_token,
  };
}

async function api(
  loginState: Login,
  path: string,
  input: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      cookie: loginState.cookie,
      ...(input.body
        ? { 'content-type': 'application/json', 'x-csrf-token': loginState.csrf }
        : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function rpc(loginState: Login, method: string, payload: Record<string, unknown>) {
  const response = await rpcResponse(loginState, method, payload);
  const body = (await response.json()) as {
    result: { ok: true; value: RpcValue } | { ok: false; error: { message: string } };
  };
  if (!response.ok || !body.result.ok) {
    throw new Error(`${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.result.value;
}

function rpcResponse(loginState: Login, method: string, payload: Record<string, unknown>) {
  return fetch(`${baseUrl}/chat/api/${method}`, {
    method: 'POST',
    headers: { cookie: loginState.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    }),
  });
}

async function prompt(loginState: Login, sessionId: string, text: string): Promise<void> {
  const value = await rpc(loginState, 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  });
  expect(value.accepted).toBe(true);
}

function history(loginState: Login, sessionId: string) {
  return rpc(loginState, 'session.history', { sessionId, maxMessages: 100 });
}

async function waitForHistory(loginState: Login, sessionId: string) {
  let result: RpcValue = {};
  await waitFor(
    async () => {
      result = await history(loginState, sessionId);
      const types = eventTypes(result);
      return types.includes('company/tool-result') && types.includes('turn/end');
    },
    120_000,
    `Session ${sessionId} did not persist Tool events`,
  );
  return result;
}

function eventTypes(historyValue: RpcValue): string[] {
  const events = Array.isArray(historyValue.events) ? historyValue.events : [];
  return events.flatMap((item) => {
    const event = (item as { event?: { type?: unknown } }).event;
    return typeof event?.type === 'string' ? [event.type] : [];
  });
}

function assertKnowledgeHistory(historyValue: RpcValue): void {
  const events = Array.isArray(historyValue.events) ? historyValue.events : [];
  const toolCall = events.find(
    (item) => (item as { event?: { type?: string } }).event?.type === 'company/tool-call',
  ) as { event?: { ignorable?: boolean } } | undefined;
  const toolResult = events.find(
    (item) => (item as { event?: { type?: string } }).event?.type === 'company/tool-result',
  ) as { event?: { data?: { citations?: unknown[] }; ignorable?: boolean } } | undefined;
  expect(toolCall?.event?.ignorable).toBe(true);
  expect(toolResult?.event?.ignorable).toBe(true);
  expect(toolResult?.event?.data?.citations?.length).toBeGreaterThan(0);
}

function openEventsSocket(cookie: string): Promise<WebSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/chat/api/events.mux`, {
      headers: { cookie, 'x-request-id': crypto.randomUUID() },
    });
    const timer = setTimeout(() => rejectSocket(new Error('WebSocket did not open')), 30_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolveSocket(socket);
    });
    socket.once('error', rejectSocket);
  });
}

async function inspectRunner(userId: string): Promise<Record<string, any>> {
  await waitFor(() => containerExists(`company-dsh-${userId}`), 30_000, `Runner ${userId} missing`);
  const inspected = await command('docker', ['inspect', `company-dsh-${userId}`]);
  return (JSON.parse(inspected.stdout) as Array<Record<string, any>>)[0]!;
}

function assertRunnerIsolation(runnerA: Record<string, any>, runnerB: Record<string, any>): void {
  expect(runnerA.Id).not.toBe(runnerB.Id);
  for (const runner of [runnerA, runnerB]) {
    expect(runner.NetworkSettings.Ports['3000/tcp']).toBeNull();
    expect(Object.keys(runner.NetworkSettings.Networks).sort()).toEqual(
      [egressNetwork, ingressNetwork].sort(),
    );
    expect(runner.HostConfig.Binds).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
  }
  const sourcesA = runnerA.Mounts.map((mount: { Source: string }) => mount.Source);
  const sourcesB = runnerB.Mounts.map((mount: { Source: string }) => mount.Source);
  expect(sourcesA.every((source: string) => source.includes(userAId))).toBe(true);
  expect(sourcesB.every((source: string) => source.includes(userBId))).toBe(true);
  expect(sourcesA).not.toEqual(sourcesB);
}

async function assertRunnerCannotCallPeer(
  runnerA: Record<string, any>,
  runnerB: Record<string, any>,
): Promise<void> {
  const peerName = String(runnerB.Name).replace(/^\//u, '');
  const peerAddress = String(runnerB.NetworkSettings.Networks[ingressNetwork].IPAddress);
  const peerRunnerId = String(runnerB.Config.Labels['company.dsh.runner-id']);
  const script = `
    const { createHmac } = require('node:crypto');
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const protectedHeader = encode({ alg: 'HS256', typ: 'JWT' });
    const claims = encode({
      iss: 'company-control-plane',
      aud: 'company-dsh-runner',
      iat: now,
      exp: now + 60,
      tenant_id: process.argv[3],
      user_id: process.argv[4],
      runner_id: process.argv[5],
      request_id: 'peer-isolation-test',
    });
    const secret = Buffer.from(process.env.COMPANY_RUNNER_IDENTITY_SECRET_BASE64, 'base64');
    const signature = createHmac('sha256', secret)
      .update(protectedHeader + '.' + claims, 'ascii')
      .digest('base64url');
    fetch('http://' + process.argv[1] + ':3000/chat/api/host.describe', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + protectedHeader + '.' + claims + '.' + signature,
        'content-type': 'application/json',
        host: process.argv[2] + ':3000',
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'peer-isolation-test',
        method: 'host.describe',
        payload: {},
      }),
    }).then((response) => {
      process.stdout.write(String(response.status));
      if (response.status !== 401) process.exitCode = 1;
    });
  `;
  const result = await command('docker', [
    'exec',
    String(runnerA.Name).replace(/^\//u, ''),
    'node',
    '-e',
    script,
    peerAddress,
    peerName,
    tenantId,
    userBId,
    peerRunnerId,
  ]);
  expect(result.stdout).toBe('401');
}

async function containerExists(name: string): Promise<boolean> {
  const result = await command('docker', ['inspect', name], { reject: false, timeoutMs: 10_000 });
  return result.code === 0;
}

async function assertContainerNamesAvailable(names: string[]): Promise<void> {
  for (const name of names) {
    if (await containerExists(name))
      throw new Error(`P0 Runner container name is already in use: ${name}`);
  }
}

async function buildImage(tag: string, dockerfile: string): Promise<void> {
  await command('docker', ['build', '--pull=false', '-f', dockerfile, '-t', tag, '.'], {
    cwd: repositoryRoot,
    timeoutMs: 900_000,
  });
}

function compose(args: string[], options: { reject?: boolean; timeoutMs?: number } = {}) {
  return command('docker', ['compose', '-p', project, '-f', composeFile, ...args], {
    ...options,
    env: composeEnvironment,
    cwd: repositoryRoot,
  });
}

async function command(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    reject?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && options.reject !== false) {
        rejectCommand(
          new Error(`${executable} ${args.join(' ')} failed (${result.code})\n${stdout}${stderr}`),
        );
      } else {
        resolveCommand(result);
      }
    });
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ''}`);
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return rejectPort(new Error('No TCP port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function startModelServer(
  requests: Array<Record<string, unknown>>,
): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'p0-mock-model' }] }));
      return;
    }
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({
      ...body,
      path: request.url,
      authorization: request.headers.authorization,
    });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const afterTool = (messages.at(-1) as { role?: string } | undefined)?.role === 'tool';
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (tools.length > 0 && !afterTool) {
      writeSse(response, {
        id: crypto.randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'p0-mock-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call-${crypto.randomUUID()}`,
                  type: 'function',
                  function: {
                    name: 'search_knowledge',
                    arguments: JSON.stringify({
                      query: '员工出差住宿报销上限',
                      category: 'company-information',
                      top_k: 3,
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    } else {
      writeSse(response, {
        id: crypto.randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'p0-mock-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'P0 mock answer with persisted citation.' },
            finish_reason: 'stop',
          },
        ],
      });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '0.0.0.0', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model mock did not bind TCP');
  return { server, port: address.port };
}

function writeSse(response: import('node:http').ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(() => resolveClose());
  });
}
