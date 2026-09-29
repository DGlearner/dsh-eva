#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const options = parseArgs(process.argv.slice(2));
const username = required(options, 'username');
const employeeId = options['employee-id'] ?? username;
const configPath = required(options, 'config');
const serverName = options['server-name'] ?? 'xiaopai';
const container = options.container ?? 'deploy-control-plane-1';
const { endpoint, token } = readMcpServer(await readFile(configPath, 'utf8'), serverName);

const result = await runContainerProvisioner(container, {
  username,
  employeeId,
  endpoint,
  token,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new Error(
        'usage: provision-remote-mcp-user --username USER --config CONFIG_TOML [--employee-id ID] [--server-name NAME] [--container NAME]',
      );
    }
    result[name.slice(2)] = value;
  }
  return result;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readMcpServer(toml, serverName) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) throw new Error('server name is invalid');
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = new RegExp(`\\[mcp_servers\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(
    toml,
  )?.[1];
  if (!section) throw new Error(`MCP server ${serverName} is missing from config`);
  const urlLiteral = /^\s*url\s*=\s*("(?:\\.|[^"])*")/m.exec(section)?.[1];
  const authorizationLiteral = /Authorization\s*=\s*("(?:\\.|[^"])*")/m.exec(section)?.[1];
  if (!urlLiteral || !authorizationLiteral) {
    throw new Error(`MCP server ${serverName} must configure url and Authorization`);
  }
  const endpoint = JSON.parse(urlLiteral);
  const authorization = JSON.parse(authorizationLiteral);
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (new URL(endpoint).protocol !== 'https:') throw new Error('MCP endpoint must use HTTPS');
  if (!token) throw new Error('MCP Authorization must contain a Bearer token');
  return { endpoint, token };
}

async function runContainerProvisioner(container, input) {
  const source = String.raw`
import pg from "pg";
import { SecretCipher } from "./dist/security.js";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const cipher = SecretCipher.fromBase64(process.env.MODEL_SECRET_KEY_BASE64);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const userResult = await client.query(
    "SELECT id, tenant_id FROM platform.users WHERE lower(username)=lower($1) AND status=$2",
    [input.username, "active"],
  );
  if (userResult.rowCount !== 1) throw new Error("active platform user was not found");
  const user = userResult.rows[0];
  const sealed = cipher.seal(input.token);
  const existing = await client.query(
    "SELECT id, ciphertext FROM platform.secrets WHERE owner_user_id=$1 AND purpose=$2 AND revoked_at IS NULL FOR UPDATE",
    [user.id, "rag_pat"],
  );
  let secretId;
  let credentialChanged = true;
  if (existing.rows[0]) {
    secretId = existing.rows[0].id;
    credentialChanged = cipher.open(Buffer.from(existing.rows[0].ciphertext).toString("utf8")) !== input.token;
    if (credentialChanged) {
      await client.query(
        "UPDATE platform.secrets SET ciphertext=$2, hint=$3, key_version=key_version+1, version=version+1, updated_at=now() WHERE id=$1",
        [secretId, Buffer.from(sealed, "utf8"), input.token.slice(-4)],
      );
    }
  } else {
    const inserted = await client.query(
      "INSERT INTO platform.secrets(owner_user_id,purpose,ciphertext,key_version,hint) VALUES ($1,$2,$3,1,$4) RETURNING id",
      [user.id, "rag_pat", Buffer.from(sealed, "utf8"), input.token.slice(-4)],
    );
    secretId = inserted.rows[0].id;
  }
  await client.query(
    "INSERT INTO platform.rag_user_bindings(user_id,rag_employee_id,token_secret_id,status) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET rag_employee_id=excluded.rag_employee_id, token_secret_id=excluded.token_secret_id, status=excluded.status, version=platform.rag_user_bindings.version+1, updated_at=now() WHERE platform.rag_user_bindings.rag_employee_id IS DISTINCT FROM excluded.rag_employee_id OR platform.rag_user_bindings.token_secret_id IS DISTINCT FROM excluded.token_secret_id OR platform.rag_user_bindings.status IS DISTINCT FROM excluded.status OR $5::boolean",
    [user.id, input.employeeId, secretId, "active", credentialChanged],
  );
  let provider = await client.query(
    "UPDATE platform.knowledge_provider_configs SET provider=$2, remote_mcp_enabled=true, endpoint=$3, auth_secret_id=NULL, allowed_tools=$4::jsonb, config_version=config_version+1, version=version+1, updated_at=now() WHERE tenant_id=$1 AND (provider IS DISTINCT FROM $2 OR remote_mcp_enabled IS DISTINCT FROM true OR endpoint IS DISTINCT FROM $3 OR auth_secret_id IS NOT NULL OR allowed_tools IS DISTINCT FROM $4::jsonb) RETURNING config_version",
    [
      user.tenant_id,
      "remote-mcp",
      input.endpoint,
      JSON.stringify(["get_current_user", "search_knowledge", "list_knowledge_documents"]),
    ],
  );
  if (provider.rowCount === 0) {
    provider = await client.query(
      "SELECT config_version FROM platform.knowledge_provider_configs WHERE tenant_id=$1",
      [user.tenant_id],
    );
  }
  if (provider.rowCount !== 1) throw new Error("tenant knowledge provider configuration was not found");
  await client.query("COMMIT");
  console.log(JSON.stringify({
    user_id: user.id,
    username: input.username,
    rag_employee_id: input.employeeId,
    provider: "remote-mcp",
    endpoint: input.endpoint,
    config_version: provider.rows[0].config_version,
    pat_encrypted: true,
    credential_changed: credentialChanged,
  }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
`;
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      '-w',
      '/app/services/control-plane',
      container,
      'node',
      '--input-type=module',
      '-e',
      source,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode !== 0) throw new Error(`remote MCP provisioning failed: ${stderr.trim()}`);
  return JSON.parse(stdout);
}
