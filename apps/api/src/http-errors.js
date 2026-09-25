/**
 * Single mapping from domain error codes to HTTP status codes, used by the
 * route layer so the status codes are unit-testable without a running server.
 *
 * Domain errors come from `trips-core.js` / `auth/permissions.js`:
 *   forbidden          -> 403 (RBAC denial)
 *   not_found          -> 404 (trip outside the token's org / unknown)
 *   order_not_found    -> 404 (referenced order does not exist in the org)
 *   invalid_*          -> 400 (bad status / illegal transition / bad input)
 *   driver_not_found,
 *   truck_not_found    -> 400 (referenced row does not exist in the org)
 *
 * Assignment conflicts (board task #36, FAv1-F5) are 409: the request is
 * well-formed but the trip/driver cannot be combined as asked—
 *   trip_closed        the trip's lifecycle has ended
 *   already_assigned   that driver already has the trip
 *   driver_unavailable the driver is locked/suspended (or not a driver)
 */

/**
 * @param {unknown} error
 * @returns {number}
 */
export function statusForError(error) {
  switch (error) {
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'order_not_found':
      return 404;
    case 'trip_closed':
    case 'already_assigned':
    case 'driver_unavailable':
      return 409;
    default:
      return 400;
  }
}
