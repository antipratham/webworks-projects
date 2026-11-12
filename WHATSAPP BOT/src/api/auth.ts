import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';
import { authenticate, type AuthenticatedCaller, type KeyScope } from '../tenancy/apiKeys.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller?: AuthenticatedCaller;
  }
}

/**
 * Authentication for every tenant-facing route.
 *
 * The key identifies the tenant, so handlers read `req.caller.tenantId` and
 * never a `tenantId` from the body. That is the point: a caller cannot name a
 * tenant it does not hold a key for, so cross-tenant access stops being
 * something the code has to remember to check.
 *
 * Where a body still carries `tenantId` — the Restaurant OS sends it today —
 * it is verified against the key and rejected on mismatch rather than ignored,
 * because a mismatch means one of the two is wrong and silently picking a
 * winner hides the bug.
 */
export function requireKey(scope: KeyScope = 'INTAKE') {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const caller = await authenticate(req.headers.authorization);

    if (scope === 'ADMIN' && caller.scope !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'This key does not carry admin scope.');
    }

    req.caller = caller;
  };
}

/** The authenticated tenant. Throws rather than returning undefined. */
export function callerOf(req: FastifyRequest): AuthenticatedCaller {
  if (!req.caller) throw new AppError('UNAUTHORIZED', 'Request is not authenticated.');
  return req.caller;
}

/**
 * Resolves the tenant for a request, checking any body-supplied value against
 * the key rather than trusting it.
 */
export function tenantOf(req: FastifyRequest, bodyTenantId?: string): string {
  const caller = callerOf(req);
  if (bodyTenantId && bodyTenantId !== caller.tenantId) {
    throw new AppError('FORBIDDEN', 'This API key does not belong to that tenant.', {
      field: 'tenantId',
    });
  }
  return caller.tenantId;
}
