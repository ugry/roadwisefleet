import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAuthSecret } from './secret.js';

test('resolveAuthSecret returns a provided AUTH_SECRET unchanged', () => {
  assert.equal(resolveAuthSecret({ env: { AUTH_SECRET: 'real-secret-value' } }), 'real-secret-value');
  assert.equal(
    resolveAuthSecret({ env: { AUTH_SECRET: '  spaced  ' } }),
    '  spaced  ',
    'a provided secret is not trimmed (it is used verbatim)',
  );
});

test('resolveAuthSecret fails fast when AUTH_SECRET is missing', () => {
  assert.throws(() => resolveAuthSecret({ env: {} }), /AUTH_SECRET is required/);
  assert.throws(
    () => resolveAuthSecret({ env: { AUTH_SECRET: '   ' } }),
    /AUTH_SECRET is required/,
    'a blank secret is not a secret',
  );
  assert.throws(
    () => resolveAuthSecret({ env: { NODE_ENV: 'production' } }),
    /AUTH_SECRET is required/,
    'production never falls back to an insecure default',
  );
  assert.throws(
    () => resolveAuthSecret({ env: { ALLOW_INSECURE_AUTH_SECRET: '0' } }),
    /AUTH_SECRET is required/,
    'only the literal 1 enables insecure mode',
  );
});

test('resolveAuthSecret uses an ephemeral random secret in explicit test mode', () => {
  assert.equal(resolveAuthSecret({ env: { NODE_ENV: 'test' }, random: () => 'ephemeral-1' }), 'ephemeral-1');
  assert.equal(
    resolveAuthSecret({ env: { ALLOW_INSECURE_AUTH_SECRET: '1' }, random: () => 'ephemeral-2' }),
    'ephemeral-2',
  );
  // A real AUTH_SECRET always wins over insecure mode.
  assert.equal(
    resolveAuthSecret({
      env: { NODE_ENV: 'test', AUTH_SECRET: 'real' },
      random: () => 'ephemeral-3',
    }),
    'real',
  );
});

test('the default ephemeral secret is random per call and never a committed constant', () => {
  const a = resolveAuthSecret({ env: { NODE_ENV: 'test' } });
  const b = resolveAuthSecret({ env: { NODE_ENV: 'test' } });
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32, 'ephemeral secret has real entropy');
  assert.notEqual(a, b, 'each process gets a fresh secret');
  assert.notEqual(a, 'pilot-dev-secret-change-me', 'the committed default is gone');
});
