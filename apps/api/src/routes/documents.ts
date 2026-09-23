import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { requireAuth } from '../auth/guard.js';
import { loadRolePermissions } from '../auth/permissions.js';
import { statusForError } from '../http-errors.js';
import {
  createDocument,
  listTripDocuments,
  shapeDocument,
  updateDocumentStatus,
  writeDocumentFile,
} from '../documents.js';

/*
 * Documents / POD API (board task #3).
 *
 * Uploads are JSON base64 (`{ docType, filename, mimeType, dataBase64 }`) so the
 * pilot needs no multipart dependency. The row is created `PENDING`, the bytes
 * are written under `env.UPLOAD_DIR` (path-traversal guarded in `documents.js`),
 * and only then does the row become `UPLOADED`; a failed write deletes the row.
 *
 * RBAC: uploading to a trip needs `trip:*` (owner/dispatcher) or `pod:upload`
 * **and** being the trip's assigned driver. Verifying/rejecting needs `trip:*`.
 * Reading a trip's documents is limited to `trip:*` or the assigned driver.
 */
export async function documentRoutes(app: FastifyInstance) {
  const auth = requireAuth(env.AUTH_SECRET);

  app.get('/trips/:id/documents', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    const { id } = req.params as { id: string };
    const result = await listTripDocuments(prisma, {
      orgId: user.orgId,
      tripId: id,
      actor: { userId: user.id, permissions },
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: result.error });
    }
    return reply.send({ documents: result.documents.map(shapeDocument) });
  });

  app.post('/trips/:id/documents', { preHandler: auth, bodyLimit: env.MAX_UPLOAD_BYTES * 2 }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    const { id } = req.params as { id: string };
    const result = await createDocument(prisma, {
      orgId: user.orgId,
      tripId: id,
      body: req.body,
      actor: { userId: user.id, permissions },
      maxBytes: env.MAX_UPLOAD_BYTES,
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: result.error, detail: result.detail });
    }

    const written = await writeDocumentFile(env.UPLOAD_DIR, result.document.storageKey, result.bytes);
    if (!written.ok) {
      // Roll the PENDING row back; nothing is left pointing at a missing file.
      await prisma.document.delete({ where: { id: result.document.id } }).catch(() => undefined);
      return reply.code(500).send({ error: 'storage_failed' });
    }
    const document = await prisma.document.update({
      where: { id: result.document.id },
      data: { status: 'UPLOADED' },
    });
    return reply.code(201).send({ document: shapeDocument(document) });
  });

  app.patch('/documents/:id', { preHandler: auth }, async (req, reply) => {
    const user = req.user;
    if (!user?.orgId) return reply.code(403).send({ error: 'no_org' });
    const permissions = await loadRolePermissions(prisma, user.roleId);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await updateDocumentStatus(prisma, {
      orgId: user.orgId,
      documentId: id,
      status: body.status,
      actor: { userId: user.id, permissions },
    });
    if (!result.ok) {
      return reply.code(statusForError(result.error)).send({ error: result.error });
    }
    return reply.send({ document: shapeDocument(result.document) });
  });
}
