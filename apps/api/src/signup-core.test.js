/**
 * Self-service registration (board task #86) — dependency-free coverage for the
 * rules the browser and the API share (`app/lib/signup.js`).
 *
 * Runs under the no-install CI job (`node --test apps/api/src/`): it imports
 * only `node:*` builtins, the UMD module and the catalogue file. The HTTP-level
 * assertions live in `apps/api/test/register-router.test.ts` (`pnpm test:router`).
 *
 * A source guard at the end is deliberate: the endpoint must keep importing this
 * same module (a copy of the rules in the route would let the two drift), and
 * the served shell must keep loading it for the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import signup from '../../../app/lib/signup.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const catalogue = JSON.parse(read('app/locales/en.json'));

const body = (over) => ({
  name: 'Ada Haulage',
  company: 'Ada Haulage GmbH',
  email: 'ada@example.com',
  password: 'correct-horse-1',
  ...over,
});

test('the password bounds the form states are the ones enforced', () => {
  assert.equal(signup.MIN_PASSWORD_LENGTH, 8);
  assert.equal(signup.MAX_PASSWORD_LENGTH, 200);
});

test('a valid registration is normalised: trimmed name/company, lower-cased email', () => {
  const result = signup.validateRegistration(body({ name: '  Ada  ', company: '  Ada GmbH ', email: ' Ada@Example.COM ' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    accountType: 'fleet',
    name: 'Ada',
    company: 'Ada GmbH',
    email: 'ada@example.com',
    password: 'correct-horse-1',
  });
});

test('a missing company is allowed and becomes the empty string', () => {
  const result = signup.validateRegistration(body({ company: '   ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.company, '');
});

test('validation is fail-fast: one field error, in field order', () => {
  // Everything wrong: the name is reported first, then email, then password.
  const name = signup.validateRegistration({ name: '', email: '', password: '' });
  assert.deepEqual({ ok: name.ok, error: name.error, field: name.field, messageKey: name.messageKey }, {
    ok: false,
    error: 'invalid_input',
    field: 'name',
    messageKey: 'signup.error.nameRequired',
  });

  const email = signup.validateRegistration({ name: 'Ada', email: '', password: '' });
  assert.equal(email.field, 'email');
  assert.equal(email.messageKey, 'signup.error.emailRequired');

  const password = signup.validateRegistration({ name: 'Ada', email: 'ada@example.com', password: '' });
  assert.equal(password.field, 'password');
  assert.equal(password.messageKey, 'signup.error.passwordShort');

  // Exactly one field is ever named.
  assert.equal('fields' in name, false);
});

test('a malformed email is refused with its own message key', () => {
  for (const email of ['ada', 'ada@', '@example.com', 'ada@example', 'ada example@x.com', 'a'.repeat(200) + '@x.com']) {
    const result = signup.validateRegistration(body({ email }));
    assert.equal(result.ok, false, email);
    assert.equal(result.field, 'email', email);
    assert.equal(result.messageKey, 'signup.error.emailInvalid', email);
  }
});

test('the password minimum and maximum are enforced exactly', () => {
  const short = signup.validateRegistration(body({ password: 'a'.repeat(7) }));
  assert.equal(short.messageKey, 'signup.error.passwordShort');
  assert.equal(signup.validateRegistration(body({ password: 'a'.repeat(8) })).ok, true);
  assert.equal(signup.validateRegistration(body({ password: 'a'.repeat(200) })).ok, true);
  const long = signup.validateRegistration(body({ password: 'a'.repeat(201) }));
  assert.equal(long.messageKey, 'signup.error.passwordLong');
  // A password is not trimmed: spaces are characters.
  assert.equal(signup.validateRegistration(body({ password: 'a'.repeat(8) + '  ' })).value.password.length, 10);
});

test('a non-object body is refused rather than thrown on', () => {
  for (const value of [null, undefined, 'x', 42, []]) {
    const result = signup.validateRegistration(value);
    assert.equal(result.ok, false, String(value));
    assert.equal(result.messageKey, 'signup.error.formInvalid', String(value));
  }
});

test('isValidEmail agrees with validateRegistration', () => {
  assert.equal(signup.isValidEmail('ada@example.com'), true);
  assert.equal(signup.isValidEmail('ada@example'), false);
  assert.equal(signup.isValidEmail(null), false);
});

test('every message key the module can return exists in the catalogue', () => {
  const probes = [
    signup.validateRegistration(null),
    signup.validateRegistration({}),
    signup.validateRegistration({ name: 'Ada', email: 'nope', password: 'x' }),
    signup.validateRegistration({ name: 'Ada', email: 'ada@example.com', password: 'x' }),
    signup.validateRegistration({ name: 'Ada', email: 'ada@example.com', password: 'x'.repeat(201) }),
    signup.validateRegistration(body()),
  ];
  const keys = probes.filter((p) => !p.ok).map((p) => p.messageKey);
  assert.ok(keys.length >= 5, `expected several error keys, saw ${keys.length}`);
  for (const key of keys) assert.ok(key in catalogue, `${key} is missing from app/locales/en.json`);
});

test('the API endpoint imports this module and the shell loads it (drift guard)', () => {
  const route = read('apps/api/src/routes/auth.ts');
  // UMD (a classic script for the page), so the route takes the CommonJS default.
  assert.match(route, /import signupRules from '\.\.\/\.\.\/\.\.\/\.\.\/app\/lib\/signup\.js'/);
  // The fleet path still validates through the shared rules (board task #111
  // dispatches to the per-type validators first).
  assert.match(route, /signupRules\.validateRegistration\(/);
  assert.doesNotMatch(route, /signupRules\.validateRegistration\(req\.body/);
  // The chosen account type is validated against the shared catalogue before any
  // row is written, so a client cannot self-upgrade.
  assert.match(route, /import accountTypes from '\.\.\/\.\.\/\.\.\/\.\.\/app\/lib\/account-types\.js'/);
  assert.match(route, /accountTypes\.isAccountType\(requested\)/);
  // The route must not restate the rules.
  assert.doesNotMatch(route, /password\.length\s*<\s*8/);

  const page = read('app/index.html');
  assert.match(page, /<script src="\/app\/lib\/signup\.js"><\/script>/);
  // The account-type catalogue the three-way signup choice is validated against.
  assert.match(page, /<script src="\/app\/lib\/account-types\.js"><\/script>/);
  const appJs = read('app/app.js');
  assert.match(appJs, /\/api\/auth\/register/);
  assert.match(appJs, /SIGNUP\.validateRegistration/);
});
