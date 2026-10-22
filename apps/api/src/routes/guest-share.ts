import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { hasPermission, loadRolePermissions } from '../auth/permissions.js';
import { resolveWithin } from '../documents.js';
import { statusForError } from '../http-errors.js';
import { isTrackLinkActive, verifyShareLink } from '../track-link.js';
import {
  DOCUMENT_SHARE_PERMISSION,
  contentDisposition,
  documentContentType,
  documentFileName,
  isShareableDocumentStatus,
  loadGuestDocument,
  mintDocumentLink,
  scopeAllowsDocType,
  shareScopeForDocType,
  shapeDocumentLink,
} from '../guest-share.js';

/*
 * Guest document + invoice share views (board task #132, UXF-O1a) — the app
 * half of board #75 that needs no WhatsApp/SMS provider, on its OWN prefix:
 *
 *   GET  /g/document/<token>          no auth -> attachment download (POD/eCMR/…)
 *   GET  /g/invoice/<token>           no auth -> inline invoice
 *   POST /api/documents/:id/share-link  bearer, trip:* -> mint a guest link
 *   GET  /api/documents/:id/share-link  bearer, trip:* -> the current link (or null)
 *
 * `/s/` belongs to the solo-driver shell (board #91) and `/track/` to the F8
 * tracking link, so the guest document surface gets `/g/<scope>/<token>` — a
 * token route is never folded into another surface's location.
 *
 * The token is the capability: `share:document:<id>~<version>` signed with the
 * same HMAC key as the tracking link (`track-link.js`), bound to the owning
 * trip's `trackLinkVersion`. So:
 *   - an unknown / malformed / expired / revoked / wrong-scope token is a flat
 *     404 JSON with no data and no cookie (same contract as `/api/track/:token`);
 *   - a tracking token never opens a document, a document token never opens
 *     tracking, and a token for document A never fetches document B;
 *   - bumping the shipment's `trackLinkVersion` (DELETE …/track-link) revokes
 *     every document link of that shipment, and a `REJECTED`/`PENDING` document
 *     is not served at all.
 *
 * Bytes come from the same storage path the upload route writes to
 * (`env.UPLOAD_DIR` + `resolveWithin`), never a second store. Every response
 * carries `x-robots-tag: noindex, nofollow` and `cache-control: no-store`.
 */

/** A guest response the browser must never cache or index. */
function guestHeaders(reply: any): void {
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('cache-control', 'no-store');
}

export async function guestShareRoutes(app: FastifyInstance) {
  const shareOptions = () => ({
    authSecret: env.AUTH_SECRET,
    secret: env.TRACK_LINK_SECRET,
  });

  /**
   * Serve one guest scope. `scope` comes from the ROUTE, never from the token,
   * so a token minted for the other scope cannot be replayed here.
   */
  const serveGuestDocument = async (scope: 'document' | 'invoice', token: unknown, reply: any) => {
    guestHeaders(reply);
    const verified = verifyShareLink(token, { scope, ...shareOptions() });
    if (!verified) return reply.code(404).send({ error: 'invalid_token' });

    const result = await loadGuestDocument(prisma, {
      scope,
      documentId: verified.documentId,
      version: verified.version,
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: 'invalid_token' });
    }

    const document = result.document;
    const file = resolveWithin(env.UPLOAD_DIR, document.storageKey);
    if (!file) return reply.code(404).send({ error: 'invalid_token' });

    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      // A row without bytes (or a file removed out of band) is indistinguishable
      // from an unknown document on the public surface.
      return reply.code(404).send({ error: 'invalid_token' });
    }

    const filename = documentFileName(document.storageKey);
    return reply
      .header('content-disposition', contentDisposition(scope, filename))
      .header('content-length', String(size))
      .type(documentContentType(document.storageKey))
      .send(createReadStream(file));
  };

  app.get('/g/document/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    return serveGuestDocument('document', token, reply);
  });

  app.get('/g/invoice/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    return serveGuestDocument('invoice', token, reply);
  });
}

export async function documentShareRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  const shareOptions = () => ({
    authSecret: env.AUTH_SECRET,
    secret: env.TRACK_LINK_SECRET,
  });

  const managePermissions = async (roleId: string | null | undefined) => {
    const permissions = await loadRolePermissions(prisma, roleId);
    return hasPermission(permissions, DOCUMENT_SHARE_PERMISSION) ? permissions : null;
  };

  /**
   * Load the document with its trip, org-scoped through the trip. Never expose
   * another org's document, and never mint for a document that is not shareable.
   */
  const loadMintable = async (orgId: string, id: string) => {
    const document = await prisma.document.findFirst({
      where: { id, trip: { orgId } },
      include: {
        trip: {
          select: {
            id: true,
            trackLinkVersion: true,
            trackLinkIssuedAt: true,
            trackLinkExpiresAt: true,
          },
        },
      },
    });
    if (!document) return { ok: false as const, error: 'not_found' };
    return { ok: true as const, document };
  };

  app.post('/documents/:id/share-link', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    if (!(await managePermissions(user.roleId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { id } = req.params as { id: string };

    const loaded = await loadMintable(user.orgId, id);
    if (!loaded.ok) return reply.code(404).send({ error: 'not_found' });
    const document = loaded.document;

    const scope = shareScopeForDocType(document.docType);
    if (!scopeAllowsDocType(scope, document.docType)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!isShareableDocumentStatus(document.status)) {
      return reply.code(409).send({ error: 'document_not_shareable', status: document.status });
    }
    // A guest link lives inside the shipment's share window: without a live
    // trip link there is nothing to bind the document link to (and nothing to
    // revoke it with).
    if (!isTrackLinkActive(document.trip)) {
      return reply.code(409).send({ error: 'no_active_link' });
    }

    const link = mintDocumentLink(document.trip, document, { scope, ...shareOptions() });
    if (!link) return reply.code(409).send({ error: 'no_active_link' });
    return reply.code(201).send({ link: shapeDocumentLink({ scope, link }, env.PUBLIC_BASE_URL) });
  });

  app.get('/documents/:id/share-link', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    if (!(await managePermissions(user.roleId))) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const { id } = req.params as { id: string };

    const loaded = await loadMintable(user.orgId, id);
    if (!loaded.ok) return reply.code(404).send({ error: 'not_found' });
    const document = loaded.document;

    const scope = shareScopeForDocType(document.docType);
    if (!scopeAllowsDocType(scope, document.docType) || !isShareableDocumentStatus(document.status)) {
      return reply.send({ link: null });
    }
    const link = mintDocumentLink(document.trip, document, { scope, ...shareOptions() });
    if (!link) return reply.send({ link: null });
    return reply.send({ link: shapeDocumentLink({ scope, link }, env.PUBLIC_BASE_URL) });
  });
}
