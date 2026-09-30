import test from 'node:test';
import assert from 'node:assert/strict';

import { statusForError } from './http-errors.js';

test('statusForError maps an RBAC denial to HTTP 403', () => {
  assert.equal(statusForError('forbidden'), 403);
});

test('statusForError maps missing rows to 404 and bad input to 400', () => {
  assert.equal(statusForError('not_found'), 404);
  assert.equal(statusForError('order_not_found'), 404);
  assert.equal(statusForError('invalid_status'), 400);
  assert.equal(statusForError('invalid_transition'), 400);
  assert.equal(statusForError('invalid_input'), 400);
  assert.equal(statusForError('driver_not_found'), 400);
  assert.equal(statusForError('truck_not_found'), 400);
  assert.equal(statusForError('something_unknown'), 400);
});

test('statusForError maps assignment conflicts to 409 (board task #36)', () => {
  assert.equal(statusForError('trip_closed'), 409);
  assert.equal(statusForError('already_assigned'), 409);
  assert.equal(statusForError('driver_unavailable'), 409);
});
