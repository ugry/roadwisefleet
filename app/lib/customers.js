/**
 * RoadwiseFleet Fleet Manager — self-serve customer lane (board task #120,
 * UXF-O3 lane 1). Pure decision logic for the `/app/customers` screen:
 * quick-add a customer, create the fleet's own manual order, and repeat an
 * existing order.
 *
 * Loaded twice, on purpose (like `dispatch.js` and `app-core.js`):
 *   - in the browser as a classic script, exposing `window.RoadwiseCustomers`;
 *   - in `apps/api/src/customers-view.test.js` on the no-install runner, so the
 *     validation and error mapping are covered with no browser and no network.
 *
 * The screen never composes its own API body: these helpers build the exact
 * bodies the server documents (`POST /api/fleet/customers`, `POST /api/orders`).
 * The server is the authority — tenant scoping is never a client field — but a
 * form that would obviously fail is refused here, before a request leaves.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RoadwiseCustomers = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function str(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  /**
   * Validate the quick-add customer form. Fail-fast: one field at a time, so
   * the UI can focus the first thing to fix (same order as the server).
   * @returns {{ ok: true, body: object } | { ok: false, field: string, key: string }}
   */
  function validateCustomerForm(form) {
    var f = form || {};
    if (!str(f.name)) return { ok: false, field: 'name', key: 'customers.error.nameRequired' };
    if (str(f.email) && !EMAIL.test(str(f.email))) return { ok: false, field: 'email', key: 'customers.error.emailInvalid' };
    return {
      ok: true,
      body: { name: str(f.name), email: str(f.email), whatsappId: str(f.whatsappId), lang: str(f.lang) || 'en' }
    };
  }

  /**
   * Validate the manual order form. `customerId` is required and comes from the
   * selected customer, never typed.
   * @returns {{ ok: true, body: object } | { ok: false, field: string, key: string }}
   */
  function validateOrderForm(form) {
    var f = form || {};
    if (!str(f.customerId)) return { ok: false, field: 'customerId', key: 'customers.error.customerRequired' };
    if (!str(f.origin)) return { ok: false, field: 'origin', key: 'customers.error.originRequired' };
    if (!str(f.destination)) return { ok: false, field: 'destination', key: 'customers.error.destinationRequired' };
    if (str(f.origin) === str(f.destination)) return { ok: false, field: 'destination', key: 'customers.error.sameRoute' };
    return {
      ok: true,
      body: {
        customerId: str(f.customerId),
        origin: str(f.origin),
        destination: str(f.destination),
        cargo: str(f.cargo),
        plannedAt: str(f.plannedAt),
        equipment: str(f.equipment),
        notes: str(f.notes)
      }
    };
  }

  /** A one-line customer label: name, then the best contact when present. */
  function customerLabel(customer) {
    if (!customer) return '';
    var contact = customer.email || customer.whatsappId || '';
    return contact ? customer.name + ' — ' + contact : String(customer.name || '');
  }

  /** The order create/repeat result as the list renders it. */
  function orderSummary(order) {
    if (!order) return '';
    return String(order.origin || '') + ' → ' + String(order.destination || '');
  }

  /**
   * Validate the invite-to-portal form (board task #120, scope item 4). The
   * fleet manager types the customer's temporary password — the same shipped
   * invite contract as `POST /api/customer/team` and `/api/fleet/drivers`: no
   * mail is sent and the response never carries a secret.
   * @returns {{ ok: true, customerId: string, body: object } | { ok: false, field: string, key: string }}
   */
  function validateInviteForm(form) {
    var f = form || {};
    var customerId = str(f.customerId);
    if (!customerId) return { ok: false, field: 'customerId', key: 'customers.error.customerRequired' };
    var email = str(f.email);
    if (!email) return { ok: false, field: 'email', key: 'signup.error.emailRequired' };
    if (!EMAIL.test(email)) return { ok: false, field: 'email', key: 'signup.error.emailInvalid' };
    var password = typeof f.password === 'string' ? f.password : '';
    if (password.length < 8) return { ok: false, field: 'password', key: 'signup.error.passwordShort' };
    if (password.length > 200) return { ok: false, field: 'password', key: 'signup.error.passwordLong' };
    return { ok: true, customerId: customerId, body: { email: email, password: password } };
  }

  /** A customer has portal access once at least one login is linked to it. */
  function hasPortalAccess(customer) {
    if (!customer) return false;
    return typeof customer.portalAccounts === 'number' && customer.portalAccounts > 0;
  }

  /**
   * Map an API error body to a catalogue key, mirroring `reasonFor` in the
   * shell: a `messageKey` first, then the server's `error`, then a generic key.
   */
  function errorKey(data) {
    if (data && typeof data.messageKey === 'string' && data.messageKey) return data.messageKey;
    if (data && data.error === 'customer_not_found') return 'customers.error.customerNotFound';
    if (data && data.error === 'order_not_found') return 'customers.error.orderNotFound';
    if (data && data.error === 'email_taken') return 'customers.error.emailTaken';
    if (data && data.error === 'forbidden') return 'error.forbidden';
    if (data && data.error === 'no_org') return 'error.noOrg';
    return 'customers.error.requestFailed';
  }

  return {
    validateCustomerForm: validateCustomerForm,
    validateOrderForm: validateOrderForm,
    validateInviteForm: validateInviteForm,
    hasPortalAccess: hasPortalAccess,
    customerLabel: customerLabel,
    orderSummary: orderSummary,
    errorKey: errorKey
  };
});
