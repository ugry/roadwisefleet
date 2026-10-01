/**
 * Realtime GPS fan-out (board task #106, AND1-A4).
 *
 * One process-wide (per server instance) publish/subscribe hub keyed by trip id.
 * The ingest route publishes each accepted point; the SSE routes
 * (`GET /api/trips/:id/stream` and `GET /api/track/:token/stream`) subscribe and
 * stream to the customer portal / fleet app / read-only link. Scoping is the
 * route's job (trip ownership / a valid signed token); the hub is transport only.
 *
 * Deliberately dependency-free and in-process. The pilot runs a single API
 * process, so there is no broker to add; if the API is ever scaled out, this is
 * the one seam to replace (a Redis pub/sub channel) and the routes stay
 * unchanged. The ADR records the trade-off.
 *
 * A slow or dead listener must never break the ingest or another listener, so
 * `publish` swallows listener errors and the route removes a listener when the
 * socket closes.
 */

/**
 * @typedef {(point: unknown) => void} GpsListener
 */

/**
 * Format one Server-Sent Event frame.
 * @param {string} event
 * @param {unknown} data
 * @returns {string}
 */
export function formatSseEvent(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/**
 * @param {{ heartbeatMs?: number }} [opts]
 */
export function createGpsHub({ heartbeatMs = 25_000 } = {}) {
  /** @type {Map<string, Set<GpsListener>>} */
  const listeners = new Map();

  return {
    /** Default SSE keep-alive interval the routes should use. */
    heartbeatMs,

    /**
     * @param {string} tripId
     * @param {GpsListener} listener
     * @returns {() => void} unsubscribe (idempotent)
     */
    subscribe(tripId, listener) {
      let set = listeners.get(tripId);
      if (!set) {
        set = new Set();
        listeners.set(tripId, set);
      }
      set.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = listeners.get(tripId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(tripId);
      };
    },

    /**
     * Deliver one point to every listener of a trip. Listener exceptions are
     * isolated: one broken consumer cannot fail the ingest or the others.
     * @param {string} tripId
     * @param {unknown} point
     */
    publish(tripId, point) {
      const set = listeners.get(tripId);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(point);
        } catch {
          /* a broken stream must not break the ingest */
        }
      }
    },

    /**
     * @param {string} tripId
     * @returns {number}
     */
    subscriberCount(tripId) {
      return listeners.get(tripId)?.size ?? 0;
    },

    /** @returns {string[]} trip ids that currently have at least one listener */
    activeTrips() {
      return [...listeners.keys()];
    },
  };
}

/** @typedef {ReturnType<typeof createGpsHub>} GpsHub */
