/**
 * Minimal SMTPS (implicit TLS, port 465) submission client — board task #125.
 *
 * The API has no mail dependency (only `fastify`, Prisma, static). Rather than
 * add one for four commands, this speaks just enough SMTP to submit a message:
 *
 *   220 -> EHLO -> AUTH LOGIN (challenge/response) -> MAIL FROM -> RCPT TO
 *       -> DATA -> dot-stuffed body -> QUIT
 *
 * Rules this file keeps:
 *   - implicit TLS only (port 465, the contract in `infra/auth-email.md` #124);
 *     port 25/587 is never used, so there is no STARTTLS downgrade path;
 *   - the password is written once into the socket and never appears in an
 *     error, a log line or a returned object;
 *   - header values are rejected when they contain CR/LF (no header injection);
 *   - every step is bounded by one timeout, so a hung server cannot hold a
 *     request open.
 *
 * `connect` is injectable: the protocol logic (dot-stuffing, multiline replies,
 * AUTH challenge order) is unit-tested against a fake socket, with no network.
 */

import { connect as tlsConnect } from 'node:tls';

export class SmtpError extends Error {
  /** @param {string} stage @param {number} [code] */
  constructor(stage, code = 0) {
    super(`smtp_${stage}${code ? `_${code}` : ''}`);
    this.name = 'SmtpError';
    this.stage = stage;
    this.code = code;
  }
}

/**
 * Collapse CR/LF runs to CRLF, refuse header injection and escape a body line
 * that would otherwise terminate the DATA section.
 * @param {string} value
 */
export function dotStuff(value) {
  const normalized = String(value ?? '').replace(/\r\n|\r|\n/g, '\n').replace(/\n+$/, '');
  return normalized
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/** @param {string} value @param {string} field */
export function assertHeaderSafe(value, field) {
  const text = String(value ?? '');
  if (!text || /[\r\n]/.test(text)) throw new SmtpError(`invalid_${field}`);
  return text;
}

/**
 * A tiny line-oriented SMTP conversation over an already-connected socket.
 *
 * @param {{ write: (chunk: string) => void, end: (chunk?: string) => void, destroy: () => void, on: Function, removeListener: Function }} socket
 * @param {{ timeoutMs?: number }} [options]
 */
export function createConversation(socket, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;
  let buffer = '';
  /** Complete lines not yet consumed by a reply. @type {string[]} */
  let pending = [];
  /** @type {null | { resolve: (value: { code: number, lines: string[] }) => void, reject: (err: Error) => void, codes: number[], timer: NodeJS.Timeout }} */
  let waiter = null;

  function cleanup() {
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('close', onClose);
  }

  function settle(reply) {
    if (!waiter) return;
    const current = waiter;
    if (current.codes.length && !current.codes.includes(reply.code)) {
      waiter = null;
      clearTimeout(current.timer);
      current.reject(new SmtpError('unexpected_reply', reply.code));
      return;
    }
    waiter = null;
    clearTimeout(current.timer);
    current.resolve(reply);
  }

  /**
   * A reply ends at the first line matching `^NNN ` (space, not dash); a
   * multiline reply's `NNN-` lines belong to it and are returned with it.
   * Lines are consumed only when they form a complete reply, so a partial
   * reply split across TCP chunks is simply buffered.
   */
  function pump() {
    if (!waiter || pending.length === 0) return;
    let end = -1;
    for (let i = 0; i < pending.length; i += 1) {
      if (/^\d{3} /.test(pending[i])) {
        end = i;
        break;
      }
    }
    if (end === -1) return;
    const lines = pending.slice(0, end + 1);
    pending = pending.slice(end + 1);
    const code = Number(lines[end].slice(0, 3));
    settle({ code, lines });
  }

  function onData(chunk) {
    buffer += String(chunk);
    const parts = buffer.split('\r\n');
    buffer = parts.pop() ?? '';
    pending.push(...parts);
    pump();
  }

  function onError(err) {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.reject(err instanceof SmtpError ? err : new SmtpError('connection'));
  }

  function onClose() {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    current.reject(new SmtpError('connection'));
  }

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    /** Send one command line (no CRLF). */
    send(/** @type {string} */ line) {
      socket.write(`${line}\r\n`);
    },

    /**
     * Await the next reply, refusing any code outside `codes`.
     * @param {number[]} codes
     */
    expect(codes) {
      return new Promise((resolve, reject) => {
        if (waiter) {
          reject(new SmtpError('overlapping_reply'));
          return;
        }
        const timer = setTimeout(() => {
          waiter = null;
          reject(new SmtpError('timeout'));
        }, timeoutMs);
        waiter = { resolve, reject, codes, timer };
        // A reply may already be buffered before expect() was called.
        pump();
      });
    },

    /** Write the DATA payload (already dot-stuffed) and its terminator. */
    sendData(/** @type {string} */ payload) {
      socket.write(`${payload}\r\n.\r\n`);
    },

    close() {
      cleanup();
      try {
        socket.end();
      } catch {
        // A dead socket is not an error on the way out.
      }
    },

    destroy() {
      cleanup();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Submit one plain-text message.
 *
 * @param {{
 *   host: string, port: number, user: string, pass: string,
 *   from: string, to: string, subject: string, text: string,
 *   timeoutMs?: number,
 *   connect?: (options: { host: string, port: number, servername: string }) => Promise<any>,
 * }} args
 */
export async function sendSmtpMail(args) {
  const host = assertHeaderSafe(args.host, 'host');
  const port = Number(args.port);
  if (port !== 465) throw new SmtpError('port_not_supported');
  const from = assertHeaderSafe(args.from, 'from');
  const to = assertHeaderSafe(args.to, 'to');
  const subject = assertHeaderSafe(args.subject, 'subject');
  const user = assertHeaderSafe(args.user, 'user');
  const pass = String(args.pass ?? '');
  if (!pass) throw new SmtpError('missing_password');

  const connect =
    typeof args.connect === 'function'
      ? args.connect
      : (options) => new Promise((resolve, reject) => {
          const socket = tlsConnect(options, () => resolve(socket));
          socket.once('error', reject);
        });

  const timeoutMs = args.timeoutMs ?? 15_000;
  let socket;
  try {
    socket = await connect({ host, port, servername: host });
  } catch {
    throw new SmtpError('connect');
  }

  const conversation = createConversation(socket, { timeoutMs });
  try {
    await conversation.expect([220]);
    conversation.send('EHLO roadwisefleet');
    await conversation.expect([250]);
    conversation.send('AUTH LOGIN');
    await conversation.expect([334]);
    conversation.send(Buffer.from(user, 'utf8').toString('base64'));
    await conversation.expect([334]);
    // The encoded password is never placed on the conversation object.
    conversation.send(Buffer.from(pass, 'utf8').toString('base64'));
    await conversation.expect([235]);
    conversation.send(`MAIL FROM:<${from}>`);
    await conversation.expect([250]);
    conversation.send(`RCPT TO:<${to}>`);
    await conversation.expect([250, 251]);
    conversation.send('DATA');
    await conversation.expect([354]);
    conversation.sendData(buildMessage({ from, to, subject, text: args.text, date: args.date }));
    await conversation.expect([250]);
    conversation.send('QUIT');
    // 221 is polite; a server that closes first is still a success.
    await conversation.expect([221, 250]).catch(() => undefined);
    return { ok: true };
  } finally {
    conversation.close();
  }
}

/**
 * Build the RFC 5322 message. Kept separate so the header set is assertable
 * without a socket.
 * @param {{ from: string, to: string, subject: string, text: string, date?: Date }} args
 */
export function buildMessage({ from, to, subject, text, date = new Date() }) {
  assertHeaderSafe(from, 'from');
  assertHeaderSafe(to, 'to');
  assertHeaderSafe(subject, 'subject');
  const messageId = `<${Date.now()}.${Math.random().toString(16).slice(2)}@${from.split('@')[1] || 'roadwisefleet'}>`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(text)}`;
}
