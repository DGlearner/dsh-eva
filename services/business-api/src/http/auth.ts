import { jwtVerify } from 'jose';
import { z } from 'zod';

import { unauthorized } from '../domain/errors.js';
import type { ActorContext } from '../domain/models.js';

const actorClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  session_id: z.string().uuid(),
  platform_role: z.enum(['admin', 'member']),
  department_id: z.string().uuid().nullable(),
  org_role: z.enum(['manager', 'member']).nullable(),
  request_id: z.string().min(8).max(128),
  iat: z.number(),
  exp: z.number(),
});

export interface ActorTokenVerifierOptions {
  secret: string;
  issuer: string;
  audience?: string;
}

export class ActorTokenVerifier {
  private readonly key: Uint8Array;
  private readonly audience: string;

  constructor(private readonly options: ActorTokenVerifierOptions) {
    if (options.secret.length < 32)
      throw new Error('Actor token secret must be at least 32 characters.');
    this.key = new TextEncoder().encode(options.secret);
    this.audience = options.audience ?? 'company-business-api';
  }

  async verify(
    authorization: string | undefined,
    requestId: string | undefined,
  ): Promise<ActorContext> {
    if (authorization === undefined || !authorization.startsWith('Bearer ')) throw unauthorized();
    if (requestId === undefined) throw unauthorized('X-Request-Id is required.');
    let payload: unknown;
    try {
      payload = (
        await jwtVerify(authorization.slice('Bearer '.length), this.key, {
          issuer: this.options.issuer,
          audience: this.audience,
          algorithms: ['HS256'],
        })
      ).payload;
    } catch {
      throw unauthorized('Actor token is invalid or expired.');
    }
    const parsed = actorClaimsSchema.safeParse(payload);
    if (!parsed.success || parsed.data.request_id !== requestId) {
      throw unauthorized('Actor token claims do not match this request.');
    }
    if (parsed.data.exp - parsed.data.iat > 60) {
      throw unauthorized('Actor token lifetime exceeds 60 seconds.');
    }
    if ((parsed.data.department_id === null) !== (parsed.data.org_role === null)) {
      throw unauthorized('Actor token organization claims are inconsistent.');
    }
    return {
      issuer: parsed.data.iss,
      tenantId: parsed.data.tenant_id,
      userId: parsed.data.user_id,
      sessionId: parsed.data.session_id,
      platformRole: parsed.data.platform_role,
      departmentId: parsed.data.department_id,
      orgRole: parsed.data.org_role,
      requestId: parsed.data.request_id,
    };
  }
}
