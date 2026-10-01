import type { FastifyReply, FastifyRequest } from 'fastify';
import { formatSseEvent } from './gps-stream.js';

/*
 * SSE transport for the realtime GPS stream (board task #106, AND1-A4).
 *
 * Shared by the authenticated fleet/portal route (`GET /api/trips/:id/stream`)
 * and the read-only share link (`GET /api/track/:token/stream`): scoping is the
 * caller's job, this module only takes over the socket and streams frames.
 *
 * `reply.hijack()` hands the raw socket to us, so Fastify never tries to send a
 * response after the handler returns. The client gets one `ready` frame, a
 * `gps` frame per accepted point, and a `: keep-alive` comment every
 * `hub.heartbeatMs` so an idle proxy does not drop the connection. The socket's
 * own timeout is disabled (an SSE connection is long-lived by design) and the
 * heartbeat timer is unref'd so it can never hold the process open in a test.
 */

/**
 * Take over the response and stream this trip's points until the client leaves.
 * @param {any} app a Fastify instance carrying the `gpsHub` decoration
 * @param {FastifyRequest} req
 * @param {FastifyReply} reply
 * @param {string} tripId
 */
export function openGpsStream(app: any, req: FastifyRequest, reply: FastifyReply, tripId: string): void {
  const hub = app.gpsHub;
  const raw = reply.raw;

  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  reply.hijack();
  req.raw.setTimeout(0);

  raw.write(formatSseEvent('ready', { tripId }));

  const unsubscribe = hub.subscribe(tripId, (point: unknown) => {
    raw.write(formatSseEvent('gps', point));
  });
  const heartbeat = setInterval(() => {
    raw.write(': keep-alive\n\n');
  }, hub.heartbeatMs);
  // Never keep the event loop (or a test) alive for the heartbeat alone.
  if (typeof (heartbeat as any).unref === 'function') (heartbeat as any).unref();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    try {
      raw.end();
    } catch {
      /* socket already gone */
    }
  };
  req.raw.on('close', close);
  req.raw.on('error', close);
}
