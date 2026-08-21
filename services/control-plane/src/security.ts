import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

import type { AuthContext, PlatformRepository, WebSessionRecord } from './domain.js';
import { HttpProblem } from './problems.js';

export const SESSION_COOKIE = 'company_session';
export const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function hashOpaque(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [];
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return key ? [[key, decodeURIComponent(value)]] : [];
    }),
  );
}

export class SecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) throw new Error('Model secret key must contain exactly 32 bytes');
  }

  static fromBase64(value: string): SecretCipher {
    return new SecretCipher(Buffer.from(value, 'base64'));
  }

  seal(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  open(sealed: string): string {
    const payload = Buffer.from(sealed, 'base64');
    if (payload.byteLength < 29) throw new Error('Encrypted model secret is malformed');
    const nonce = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  }
}

export async function authenticate(
  request: FastifyRequest,
  repository: PlatformRepository,
  options: { requireCsrf?: boolean; now?: Date } = {},
): Promise<AuthContext> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) throw new HttpProblem(401, 'authentication_required', 'Authentication is required');

  const now = options.now ?? new Date();
  const session = await repository.getWebSessionByTokenHash(hashOpaque(token));
  if (
    !session ||
    session.revokedAt ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now
  ) {
    throw new HttpProblem(401, 'session_expired', 'Session is missing, expired, or revoked');
  }

  const user = await repository.getUser(session.userId);
  if (!user || user.status !== 'active') {
    if (session) await repository.revokeWebSession(session.id);
    throw new HttpProblem(401, 'account_unavailable', 'Account is not active');
  }

  const csrfToken = request.headers['x-csrf-token'];
  if (options.requireCsrf) {
    if (typeof csrfToken !== 'string' || hashOpaque(csrfToken) !== session.csrfHash) {
      throw new HttpProblem(403, 'csrf_invalid', 'CSRF token is missing or invalid');
    }
  }

  const nextIdle = new Date(
    Math.min(now.getTime() + IDLE_SESSION_MS, session.absoluteExpiresAt.getTime()),
  );
  await repository.touchWebSession(session.id, nextIdle);
  const membership = await repository.getMembership(user.id);
  const department = membership ? await repository.getDepartment(membership.departmentId) : null;

  return {
    session: { ...session, idleExpiresAt: nextIdle },
    user,
    membership,
    department,
    csrfToken: typeof csrfToken === 'string' ? csrfToken : '',
  };
}

export function createSessionRecord(
  userId: string,
  now = new Date(),
): {
  token: string;
  csrfToken: string;
  record: WebSessionRecord;
} {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  return {
    token,
    csrfToken,
    record: {
      id: crypto.randomUUID(),
      tokenHash: hashOpaque(token),
      csrfHash: hashOpaque(csrfToken),
      userId,
      idleExpiresAt: new Date(now.getTime() + IDLE_SESSION_MS),
      absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_SESSION_MS),
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '::' || address.toLowerCase().startsWith('fe80:'))
    return true;
  if (address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd')) return true;
  if (!isIP(address)) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export async function validateExternalBaseUrl(
  value: string,
  options: { allowedAuthorities?: ReadonlySet<string> } = {},
): Promise<URL> {
  const declaredProtocol = /^[a-z][a-z\d+.-]*:/i.exec(value)?.[0].toLowerCase();
  if (declaredProtocol && declaredProtocol !== 'https:' && declaredProtocol !== 'http:') {
    throw new HttpProblem(422, 'model_url_protocol', 'Model base URL must use HTTP or HTTPS');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpProblem(422, 'model_url_invalid', 'Model base URL must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpProblem(422, 'model_url_protocol', 'Model base URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new HttpProblem(
      422,
      'model_url_credentials',
      'Model base URL must not contain credentials',
    );
  }
  if (options.allowedAuthorities?.has(url.host.toLocaleLowerCase('en-US'))) return url;

  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpProblem(
      422,
      'model_url_disallowed',
      'Model base URL resolves to a disallowed address',
    );
  }
  return url;
}

export class FixedWindowLoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maximum = 10,
    private readonly windowMs = 60_000,
  ) {}

  assertAllowed(key: string, now = Date.now()): void {
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    if (current.count >= this.maximum) {
      throw new HttpProblem(429, 'login_rate_limited', 'Too many login attempts');
    }
    current.count += 1;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
