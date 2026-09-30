/**
 * RoadwiseFleet — self-service registration (board task #86).
 *
 * The rules a new fleet owner's signup must pass: a name, a valid email and a
 * password of at least 8 characters (company is optional). One rule set shared
 * by the browser and the API — the same discipline as `app-core.js` and
 * `dispatch.js` — so the client can never be more permissive than the server:
 *
 *   - in the browser, as a classic script (`<script src="/app/lib/signup.js">`),
 *     which exposes `window.RoadwiseSignup`;
 *   - in the API (`apps/api/src/routes/auth.ts` imports it for
 *     `POST /api/auth/register`) and in the no-install test suite
 *     (`apps/api/src/signup-core.test.js`).
 *
 * Nothing here touches the DOM, the network, storage or the clock: decision
 * logic only. ES5-compatible syntax (the pilot targets cheap Android WebViews).
 *
 * Validation is FAIL-FAST: exactly one field error per submit, in field order
 * (name, email, password), so the form can focus the one thing to fix.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseSignup = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The server must accept what the client accepts — keep these in sync. */
  var MIN_PASSWORD_LENGTH = 8;
  var MAX_PASSWORD_LENGTH = 200;
  var MAX_NAME_LENGTH = 120;
  var MAX_COMPANY_LENGTH = 120;
  var MAX_EMAIL_LENGTH = 200;

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Trim and cap a free-text value.
   * @param {unknown} value
   * @param {number} max
   * @returns {string}
   */
  function text(value, max) {
    if (value === null || value === undefined) return '';
    var s = String(value).trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  /**
   * A loose but real email check. The API is authoritative; this is UX and the
   * server-side gate in the same terms.
   * @param {unknown} value
   * @returns {boolean}
   */
  function isValidEmail(value) {
    if (typeof value !== 'string') return false;
    var s = value.trim();
    if (s.length < 5 || s.length > MAX_EMAIL_LENGTH) return false;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
  }

  /**
   * @param {string} field
   * @param {string} messageKey a catalogue key the form can translate
   * @param {string} detail
   * @returns {{ ok: false, error: string, field: string, messageKey: string, detail: string }}
   */
  function fail(field, messageKey, detail) {
    return { ok: false, error: 'invalid_input', field: field, messageKey: messageKey, detail: detail || messageKey };
  }

  /**
   * Validate a registration body and normalise it. Email is lower-cased (the
   * `User.email` unique index is the duplicate check), the password is never
   * trimmed (spaces are legitimate characters in a password).
   * @param {unknown} body
   * @returns {{ ok: true, value: { name: string, company: string, email: string, password: string } } | { ok: false, error: string, field: string, messageKey: string, detail: string }}
   */
  function validateRegistration(body) {
    if (!isObject(body)) {
      return fail('form', 'signup.error.formInvalid', 'body must be an object');
    }
    var b = /** @type {Record<string, any>} */ (body);

    var name = text(b.name, MAX_NAME_LENGTH);
    if (!name) return fail('name', 'signup.error.nameRequired', 'name is required');

    var email = text(b.email, MAX_EMAIL_LENGTH).toLowerCase();
    if (!email) return fail('email', 'signup.error.emailRequired', 'email is required');
    if (!isValidEmail(email)) return fail('email', 'signup.error.emailInvalid', 'email is not valid');

    var password = typeof b.password === 'string' ? b.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return fail(
        'password',
        'signup.error.passwordShort',
        'password must be at least ' + MIN_PASSWORD_LENGTH + ' characters',
      );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return fail('password', 'signup.error.passwordLong', 'password is too long');
    }

    return {
      ok: true,
      value: {
        name: name,
        company: text(b.company, MAX_COMPANY_LENGTH),
        email: email,
        password: password,
      },
    };
  }

  return {
    MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH: MAX_PASSWORD_LENGTH,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_COMPANY_LENGTH: MAX_COMPANY_LENGTH,
    MAX_EMAIL_LENGTH: MAX_EMAIL_LENGTH,
    isValidEmail: isValidEmail,
    validateRegistration: validateRegistration,
  };
});
