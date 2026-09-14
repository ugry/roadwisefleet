import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { bearerToken, verifyToken } from './tokens.js';

/**
 * The authenticated principal attached to a request by `requireAuth`.
 * `orgId` comes from the signed token, never from a client header.
 */
export interface AuthUser {
  id: string;
  orgId: string | null;
  roleId: string | null;
  name: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Build the auth preHandler. Verifies the bearer token's signature and expiry
 * and attaches the decoded principal. Real auth replaces the old `x-org-id`
 * trust-the-header stub on the trip routes.
 */
export function requireAuth(secret: string): preHandlerHookHandler {
  return async function authGuard(req: FastifyRequest, reply: FastifyReply) {
    const payload = verifyToken(bearerToken(req.headers.authorization), secret);
    if (!payload) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.user = {
      id: payload.sub,
      orgId: payload.org,
      roleId: payload.role,
      name: payload.name,
    };
  };
}
