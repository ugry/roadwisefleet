/**
 * Email transport contract — board task #125.
 *
 * Pins the #124 five-key contract, the fail-closed behaviour (no credential ->
 * nothing is sent, and no code is echoed anywhere) and the message text.
 * Dependency-free, so the no-install CI job runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_EMAIL_ENV_KEYS,
  AUTH_EMAIL_SMTP_PORT,
  buildCodeEmail,
  createEmailSender,
  resolveEmailConfig,
} from './email-transport.js';
import { SmtpError } from './smtp-client.js';

const FULL = {
  AUTH_EMAIL_SMTP_HOST: 'mail.elilaltd.com',
  AUTH_EMAIL_SMTP_PORT: '465',
  AUTH_EMAIL_SMTP_USER: 'no-reply@elilaltd.com',
  AUTH_EMAIL_SMTP_PASS: 'not-a-real-password',
  AUTH_EMAIL_FROM: 'no-reply@elilaltd.com',
};

test('the contract is exactly the five #124 keys, on port 465', () => {
  assert.deepEqual(
    AUTH_EMAIL_ENV_KEYS.slice().sort(),
    [
      'AUTH_EMAIL_FROM',
      'AUTH_EMAIL_SMTP_HOST',
      'AUTH_EMAIL_SMTP_PASS',
      'AUTH_EMAIL_SMTP_PORT',
      'AUTH_EMAIL_SMTP_USER',
    ],
  );
  assert.equal(AUTH_EMAIL_SMTP_PORT, 465);
});

test('resolveEmailConfig: configured only when every key is present', () => {
  const config = resolveEmailConfig(FULL);
  assert.equal(config.configured, true);
  assert.equal(config.problem, null);
  assert.deepEqual(config.missing, []);
  assert.equal(config.host, 'mail.elilaltd.com');
  assert.equal(config.port, 465);
  assert.equal(config.from, 'no-reply@elilaltd.com');
});

test('resolveEmailConfig: names every missing key and stays fail-closed', () => {
  const config = resolveEmailConfig({ ...FULL, AUTH_EMAIL_SMTP_PASS: '' });
  assert.equal(config.configured, false);
  assert.equal(config.problem, 'not_configured');
  assert.deepEqual(config.missing, ['AUTH_EMAIL_SMTP_PASS']);

  const empty = resolveEmailConfig({});
  assert.equal(empty.configured, false);
  assert.equal(empty.problem, 'not_configured');
  assert.equal(empty.missing.length, 5);
});

test('resolveEmailConfig: a port other than 465 is refused (no STARTTLS fallback)', () => {
  const config = resolveEmailConfig({ ...FULL, AUTH_EMAIL_SMTP_PORT: '587' });
  assert.equal(config.configured, false);
  assert.equal(config.problem, 'port_not_supported');
  assert.deepEqual(config.missing, ['AUTH_EMAIL_SMTP_PORT']);
});

test('buildCodeEmail: the code and the 10-minute lifetime, nothing about the account', () => {
  const login = buildCodeEmail({ code: '123456', purpose: 'login' });
  assert.equal(login.subject, 'Your RoadwiseFleet sign-in code');
  assert.match(login.text, /123456/);
  assert.match(login.text, /10 minutes/);
  assert.match(login.text, /used once/);
  // No link, no name, no organisation, no address.
  assert.doesNotMatch(login.text, /https?:\/\//);
  assert.doesNotMatch(login.text, /@/);

  const verify = buildCodeEmail({ code: '654321', purpose: 'verify' });
  assert.equal(verify.subject, 'Confirm your RoadwiseFleet email');
  assert.match(verify.text, /654321/);
});

test('createEmailSender: fail-closed without the credential — no send, no code leaked', async () => {
  const events = [];
  let calls = 0;
  const sender = createEmailSender({
    env: {},
    sendMail: async () => {
      calls += 1;
      return { ok: true };
    },
    log: (event, detail) => events.push([event, detail]),
  });
  assert.equal(sender.configured, false);
  const result = await sender.sendCode({ to: 'driver@example.com', code: '123456', purpose: 'login' });
  assert.deepEqual(result, { sent: false, reason: 'not_configured' });
  assert.equal(calls, 0);
  assert.deepEqual(events, [['auth.email.not_configured', { problem: 'not_configured' }]]);
  // The log line never carries the address or the code.
  assert.doesNotMatch(JSON.stringify(events), /driver@example\.com|123456|not-a-real-password/);
});

test('createEmailSender: passes the message to the injected transport', async () => {
  const sent = [];
  const sender = createEmailSender({
    env: FULL,
    sendMail: async (message) => {
      sent.push(message);
      return { ok: true };
    },
  });
  assert.equal(sender.configured, true);
  const result = await sender.sendCode({ to: 'driver@example.com', code: '424242', purpose: 'verify' });
  assert.deepEqual(result, { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'driver@example.com');
  assert.equal(sent[0].from, 'no-reply@elilaltd.com');
  assert.equal(sent[0].host, 'mail.elilaltd.com');
  assert.equal(sent[0].port, 465);
  assert.match(sent[0].text, /424242/);
  assert.equal(sent[0].subject, 'Confirm your RoadwiseFleet email');
});

test('createEmailSender: a transport failure is reported, never thrown, and leaks no secret', async () => {
  const events = [];
  const sender = createEmailSender({
    env: FULL,
    sendMail: async () => {
      throw new SmtpError('unexpected_reply', 535);
    },
    log: (event, detail) => events.push([event, detail]),
  });
  const result = await sender.sendCode({ to: 'driver@example.com', code: '123456', purpose: 'login' });
  assert.deepEqual(result, { sent: false, reason: 'unexpected_reply' });
  assert.deepEqual(events, [['auth.email.send_failed', { reason: 'unexpected_reply' }]]);
  assert.doesNotMatch(JSON.stringify(events), /not-a-real-password|123456|driver@example\.com/);
});
