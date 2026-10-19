/**
 * SMTPS client — protocol tests against a fake socket (board task #125).
 *
 * No network, no TLS, no credential: the fake socket scripts the server's
 * replies, so the AUTH LOGIN order, multiline replies, DATA dot-stuffing and
 * the refusal paths are all pinned. Runs in the no-install CI job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  SmtpError,
  buildMessage,
  createConversation,
  dotStuff,
  sendSmtpMail,
} from './smtp-client.js';

/**
 * A socket that records writes and answers each one from a script.
 * @param {string[]} script one reply per write
 * @param {{ greeting?: boolean }} [options] `false` for a bare conversation that
 *   is already past the 220 greeting (the submit test supplies it explicitly)
 */
function fakeSocket(script, options = {}) {
  const socket = new EventEmitter();
  socket.written = [];
  socket.write = (chunk) => {
    socket.written.push(String(chunk));
    const reply = script.shift();
    if (reply !== undefined) setImmediate(() => socket.emit('data', reply));
  };
  socket.end = () => {};
  socket.destroy = () => {};
  // Greeting, before any client line (unless the caller is testing a step
  // the server has already reached).
  if (options.greeting !== false) {
    setImmediate(() => socket.emit('data', '220 mail.elilaltd.com ESMTP\r\n'));
  }
  return socket;
}


test('dotStuff escapes a leading dot and normalises line endings', () => {
  assert.equal(dotStuff('a\n.b\nc'), 'a\r\n..b\r\nc');
  assert.equal(dotStuff('a\r\nb\r\n'), 'a\r\nb');
  assert.equal(dotStuff('...x'), '....x');
});

test('conversation parses a multiline reply and resolves on the final line', async () => {
  const socket = fakeSocket(['250-mail\r\n250-SIZE 10240000\r\n250 AUTH LOGIN\r\n'], { greeting: false });
  const conversation = createConversation(socket);
  conversation.send('EHLO test');
  const reply = await conversation.expect([250]);
  assert.equal(reply.code, 250);
  assert.equal(reply.lines.length, 3);
  conversation.destroy();
});

test('conversation buffers a reply split across TCP chunks', async () => {
  const socket = fakeSocket([], { greeting: false });
  const conversation = createConversation(socket);
  conversation.send('EHLO test');
  const pending = conversation.expect([250]);
  setImmediate(() => socket.emit('data', '250-fir'));
  setImmediate(() => socket.emit('data', 'st\r\n250 OK\r\n'));
  const reply = await pending;
  assert.equal(reply.code, 250);
  conversation.destroy();
});

test('conversation rejects a code outside the allowed set', async () => {
  const socket = fakeSocket(['535 5.7.8 Authentication credentials invalid\r\n'], { greeting: false });
  const conversation = createConversation(socket);
  conversation.send('AUTH LOGIN');
  await assert.rejects(conversation.expect([235]), (err) => {
    assert.ok(err instanceof SmtpError);
    assert.equal(err.stage, 'unexpected_reply');
    assert.equal(err.code, 535);
    return true;
  });
  conversation.destroy();
});

test('conversation times out on a silent server', async () => {
  const socket = fakeSocket([], { greeting: false });
  const conversation = createConversation(socket, { timeoutMs: 30 });
  conversation.send('EHLO test');
  await assert.rejects(conversation.expect([250]), (err) => err instanceof SmtpError && err.stage === 'timeout');
  conversation.destroy();
});

test('sendSmtpMail drives the full submission in the right order', async () => {
  const script = [
    '250 mail.elilaltd.com\r\n', // EHLO
    '334 VXNlcm5hbWU6\r\n', // AUTH LOGIN -> user challenge
    '334 UGFzc3dvcmQ6\r\n', // -> password challenge
    '235 2.7.0 Authentication successful\r\n',
    '250 2.1.0 Ok\r\n', // MAIL FROM
    '250 2.1.5 Ok\r\n', // RCPT TO
    '354 End data with <CR><LF>.<CR><LF>\r\n',
    '250 2.0.0 Ok: queued\r\n', // body
    '221 2.0.0 Bye\r\n', // QUIT
  ];
  const socket = fakeSocket(script);
  let connected = null;
  const result = await sendSmtpMail({
    host: 'mail.elilaltd.com',
    port: 465,
    user: 'no-reply@elilaltd.com',
    pass: 'not-a-real-password',
    from: 'no-reply@elilaltd.com',
    to: 'driver@example.com',
    subject: 'Your RoadwiseFleet sign-in code',
    text: 'Your code: 123456\n.ok',
    connect: async (options) => {
      connected = options;
      return socket;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(connected, { host: 'mail.elilaltd.com', port: 465, servername: 'mail.elilaltd.com' });

  const written = socket.written;
  assert.equal(written[0], 'EHLO roadwisefleet\r\n');
  assert.equal(written[1], 'AUTH LOGIN\r\n');
  assert.equal(written[2], `${Buffer.from('no-reply@elilaltd.com').toString('base64')}\r\n`);
  assert.equal(written[3], `${Buffer.from('not-a-real-password').toString('base64')}\r\n`);
  assert.equal(written[4], 'MAIL FROM:<no-reply@elilaltd.com>\r\n');
  assert.equal(written[5], 'RCPT TO:<driver@example.com>\r\n');
  assert.equal(written[6], 'DATA\r\n');
  // The body is dot-stuffed and terminated.
  assert.match(written[7], /Subject: Your RoadwiseFleet sign-in code\r\n/);
  assert.match(written[7], /\r\n\r\nYour code: 123456\r\n\.\.ok\r\n\.\r\n$/);
  assert.equal(written[8], 'QUIT\r\n');
});

test('sendSmtpMail refuses any port but 465 before connecting', async () => {
  let connected = false;
  await assert.rejects(
    sendSmtpMail({
      host: 'mail.elilaltd.com',
      port: 587,
      user: 'u',
      pass: 'p',
      from: 'no-reply@elilaltd.com',
      to: 'driver@example.com',
      subject: 's',
      text: 't',
      connect: async () => {
        connected = true;
        return fakeSocket([]);
      },
    }),
    (err) => err instanceof SmtpError && err.stage === 'port_not_supported',
  );
  assert.equal(connected, false);
});

test('sendSmtpMail refuses header injection in the recipient', async () => {
  let connected = false;
  await assert.rejects(
    sendSmtpMail({
      host: 'mail.elilaltd.com',
      port: 465,
      user: 'u',
      pass: 'p',
      from: 'no-reply@elilaltd.com',
      to: 'driver@example.com\r\nBcc: evil@example.com',
      subject: 's',
      text: 't',
      connect: async () => {
        connected = true;
        return fakeSocket([]);
      },
    }),
    (err) => err instanceof SmtpError && err.stage === 'invalid_to',
  );
  assert.equal(connected, false);
});

test('a 535 on AUTH never puts the password into the error', async () => {
  const socket = fakeSocket([
    '250 mail.elilaltd.com\r\n',
    '334 VXNlcm5hbWU6\r\n',
    '334 UGFzc3dvcmQ6\r\n',
    '535 5.7.8 Authentication credentials invalid\r\n',
  ]);
  const password = 'super-secret-passphrase';
  let error = null;
  try {
    await sendSmtpMail({
      host: 'mail.elilaltd.com',
      port: 465,
      user: 'no-reply@elilaltd.com',
      pass: password,
      from: 'no-reply@elilaltd.com',
      to: 'driver@example.com',
      subject: 's',
      text: 't',
      connect: async () => socket,
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof SmtpError);
  assert.equal(error.stage, 'unexpected_reply');
  assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /super-secret-passphrase/);
});

test('buildMessage carries the required headers and no Bcc', () => {
  const message = buildMessage({
    from: 'no-reply@elilaltd.com',
    to: 'driver@example.com',
    subject: 'Subject line',
    text: 'Body',
    date: new Date('2026-10-19T12:00:00.000Z'),
  });
  assert.match(message, /^From: no-reply@elilaltd\.com\r\n/);
  assert.match(message, /\r\nTo: driver@example\.com\r\n/);
  assert.match(message, /\r\nSubject: Subject line\r\n/);
  assert.match(message, /\r\nDate: Mon, 19 Oct 2026 12:00:00 GMT\r\n/);
  assert.match(message, /\r\nMessage-ID: </);
  assert.match(message, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(message, /\r\nAuto-Submitted: auto-generated\r\n/);
  assert.doesNotMatch(message, /Bcc:/);
  assert.match(message, /\r\n\r\nBody$/);
});

test('a reply that arrives before expect() is retained', async () => {
  // Guards the buffering: SMTP servers may answer the previous command while the
  // client is still composing the next expect() call.
  const socket = fakeSocket([], { greeting: false });
  const conversation = createConversation(socket);
  socket.emit('data', '220 mail.elilaltd.com ESMTP\r\n');
  const reply = await conversation.expect([220]);
  assert.equal(reply.code, 220);
  conversation.destroy();
});
