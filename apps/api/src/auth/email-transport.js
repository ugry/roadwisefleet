/**
 * Email delivery for one-time codes (board task #125), consuming the delivery
 * contract owned by board task #124 (`infra/auth-email.md`).
 *
 * The five keys are the ONLY way the API learns how to send mail:
 *
 *   AUTH_EMAIL_SMTP_HOST
 *   AUTH_EMAIL_SMTP_PORT   (465 only — implicit TLS)
 *   AUTH_EMAIL_SMTP_USER
 *   AUTH_EMAIL_SMTP_PASS
 *   AUTH_EMAIL_FROM
 *
 * The credential lives in `/etc/roadwisefleet/auth-email.env` (0600 root) and is
 * read by the API unit as a second `EnvironmentFile`; it is NEVER in the repo,
 * in a build artifact, in a response or in a log line. When any key is missing
 * the sender is **fail-closed**: it reports `not_configured` and no code is
 * delivered (the request endpoint still answers generically — see the route).
 *
 * `sendMail` is injectable so the transport contract, the message text and the
 * fail-closed behaviour are pinned without a network or a real credential.
 */

import { OTP_TTL_SECONDS } from '../email-otp.js';
import { sendSmtpMail, SmtpError } from './smtp-client.js';

export const AUTH_EMAIL_ENV_KEYS = Object.freeze([
  'AUTH_EMAIL_SMTP_HOST',
  'AUTH_EMAIL_SMTP_PORT',
  'AUTH_EMAIL_SMTP_USER',
  'AUTH_EMAIL_SMTP_PASS',
  'AUTH_EMAIL_FROM',
]);

/** The only port the contract allows (implicit TLS, no STARTTLS downgrade). */
export const AUTH_EMAIL_SMTP_PORT = 465;

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the delivery contract from an environment object.
 *
 * The returned object carries the password (the sender needs it); never
 * JSON-stringify it, never log it, never include it in an error.
 *
 * @param {Record<string, string | undefined>} [source]
 * @returns {{
 *   configured: boolean,
 *   problem: string | null,
 *   missing: string[],
 *   host: string, port: number, user: string, pass: string, from: string,
 * }}
 */
export function resolveEmailConfig(source = process.env) {
  const host = text(source.AUTH_EMAIL_SMTP_HOST);
  const rawPort = text(source.AUTH_EMAIL_SMTP_PORT);
  const port = rawPort ? Number(rawPort) : 0;
  const user = text(source.AUTH_EMAIL_SMTP_USER);
  const pass = typeof source.AUTH_EMAIL_SMTP_PASS === 'string' ? source.AUTH_EMAIL_SMTP_PASS : '';
  const from = text(source.AUTH_EMAIL_FROM);

  const missing = ['AUTH_EMAIL_SMTP_HOST', 'AUTH_EMAIL_SMTP_USER', 'AUTH_EMAIL_FROM'].filter(
    (key) => !text(source[key]),
  );
  // Checked separately so an empty password is named but never echoed.
  if (!pass) missing.push('AUTH_EMAIL_SMTP_PASS');
  if (!rawPort || port !== AUTH_EMAIL_SMTP_PORT) missing.push('AUTH_EMAIL_SMTP_PORT');

  let problem = null;
  if (missing.length) {
    problem = rawPort && port !== AUTH_EMAIL_SMTP_PORT ? 'port_not_supported' : 'not_configured';
  }

  return {
    configured: missing.length === 0 && port === AUTH_EMAIL_SMTP_PORT,
    problem,
    missing,
    host,
    port: port || AUTH_EMAIL_SMTP_PORT,
    user,
    pass,
    from,
  };
}

/**
 * The message body. Deliberately never contains a link, an account name or any
 * other fact about the recipient — just the code, its lifetime and what to do
 * if it was not requested.
 *
 * @param {{ code: string, purpose: string, ttlSeconds?: number }} args
 */
export function buildCodeEmail({ code, purpose, ttlSeconds = OTP_TTL_SECONDS }) {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const isVerify = purpose === 'verify';
  const subject = isVerify ? 'Confirm your RoadwiseFleet email' : 'Your RoadwiseFleet sign-in code';
  const intro = isVerify
    ? 'Confirm your RoadwiseFleet email address with this code:'
    : 'Your RoadwiseFleet sign-in code:';
  const body = [
    intro,
    '',
    `    ${code}`,
    '',
    `The code expires in ${minutes} minutes and can be used once.`,
    'If you did not ask for it, ignore this message — nothing changes.',
    '',
    'RoadwiseFleet',
  ].join('\n');
  return { subject, text: body };
}

/**
 * Create the sender the route uses.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   sendMail?: typeof sendSmtpMail,
 *   log?: (event: string, detail?: Record<string, unknown>) => void,
 * }} [options]
 */
export function createEmailSender(options = {}) {
  const config = resolveEmailConfig(options.env ?? process.env);
  const sendMail = options.sendMail ?? sendSmtpMail;
  const log = options.log ?? (() => {});

  return {
    configured: config.configured,
    missing: config.missing.slice(),
    problem: config.problem,

    /**
     * Deliver a code. Never throws: a delivery failure must not turn a generic
     * "we sent it if the account exists" response into an enumeration oracle.
     *
     * @param {{ to: string, code: string, purpose: string }} args
     * @returns {Promise<{ sent: boolean, reason?: string }>}
     */
    async sendCode({ to, code, purpose }) {
      if (!config.configured) {
        // No address, no code, no credential in the log line — only the reason.
        log('auth.email.not_configured', { problem: config.problem ?? 'not_configured' });
        return { sent: false, reason: config.problem ?? 'not_configured' };
      }
      const { subject, text: body } = buildCodeEmail({ code, purpose });
      try {
        await sendMail({
          host: config.host,
          port: config.port,
          user: config.user,
          pass: config.pass,
          from: config.from,
          to,
          subject,
          text: body,
        });
        return { sent: true };
      } catch (err) {
        const reason = err instanceof SmtpError ? err.stage : 'transport_error';
        log('auth.email.send_failed', { reason });
        return { sent: false, reason };
      }
    },
  };
}
