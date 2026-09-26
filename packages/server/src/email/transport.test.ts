/**
 * Email transport unit tests.
 *
 * vi.mock('nodemailer') is hoisted by Vitest so it intercepts the ESM import
 * inside transport.ts. vi.hoisted() is used to declare shared spy variables
 * that are referenced inside the vi.mock() factory — this avoids the
 * "Cannot access before initialization" TDZ error that occurs when top-level
 * const/let are referenced inside the hoisted factory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist shared spies — MUST use vi.hoisted() so they are available inside
// the vi.mock() factory (which is moved to the top of the module by Vitest).
// ---------------------------------------------------------------------------

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

// Intercept `import nodemailer from 'nodemailer'` inside transport.ts.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

// ---------------------------------------------------------------------------
// Import under test — after vi.mock declaration so the factory is registered
// ---------------------------------------------------------------------------

import { getRealEmailTransport } from './transport.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'rustsfadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustsfadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '[]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-transport-tests-123456789',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
  // Reset mock call counts between tests so assertions are independent.
  sendMailMock.mockReset();
  createTransportMock.mockReset();
  // Re-attach the sendMail spy to the freshly-reset createTransport mock.
  createTransportMock.mockReturnValue({ sendMail: sendMailMock });
});

// ---------------------------------------------------------------------------
// SMTP disabled (empty SMTP_URL) — stub path
// ---------------------------------------------------------------------------

describe('getRealEmailTransport — SMTP disabled', () => {
  it('returns a function (stub) that does not throw', async () => {
    const send = getRealEmailTransport({ SMTP_URL: '', SMTP_FROM: '' });
    // Should resolve without throwing.
    await expect(
      send({ to: 'test@example.com', subject: 'Test', text: 'Hello' }),
    ).resolves.toBeUndefined();
  });

  it('stub does not call nodemailer createTransport', async () => {
    const send = getRealEmailTransport({ SMTP_URL: '', SMTP_FROM: '' });
    await send({ to: 'a@b.com', subject: 'sub', text: 'body', html: '<p>body</p>' });
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SMTP configured — nodemailer path (exercises getRealEmailTransport directly)
// ---------------------------------------------------------------------------

describe('getRealEmailTransport — SMTP configured', () => {
  it('calls createTransport with the SMTP_URL on first send', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'test-id' });

    const send = getRealEmailTransport({
      SMTP_URL: 'smtp://localhost:25',
      SMTP_FROM: '',
    });

    await send({ to: 'student@berkeley.edu', subject: 'Invite', text: 'Join us' });

    // createTransport must have been called exactly once with the SMTP_URL.
    expect(createTransportMock).toHaveBeenCalledOnce();
    expect(createTransportMock).toHaveBeenCalledWith('smtp://localhost:25');
  });

  it('passes the correct message fields to sendMail (no html when omitted)', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-1' });

    const send = getRealEmailTransport({
      SMTP_URL: 'smtp://localhost:25',
      SMTP_FROM: 'noreply@example.com',
    });

    await send({ to: 'student@berkeley.edu', subject: 'Invite', text: 'Join us' });

    expect(sendMailMock).toHaveBeenCalledOnce();
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'noreply@example.com',
        to: 'student@berkeley.edu',
        subject: 'Invite',
        text: 'Join us',
      }),
    );
    // html should NOT be present when not provided
    expect(sendMailMock.mock.calls[0]?.[0]).not.toHaveProperty('html');
  });

  it('includes html in sendMail call when provided', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-2' });

    const send = getRealEmailTransport({
      SMTP_URL: 'smtp://localhost:25',
      SMTP_FROM: '',
    });

    await send({
      to: 'a@b.com',
      subject: 'sub',
      text: 'body',
      html: '<p>body</p>',
    });

    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ html: '<p>body</p>' }));
  });

  it('sets from to undefined when SMTP_FROM is empty', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-3' });

    const send = getRealEmailTransport({
      SMTP_URL: 'smtp://localhost:25',
      SMTP_FROM: '',
    });

    await send({ to: 'a@b.com', subject: 'sub', text: 'body' });

    expect(sendMailMock).toHaveBeenCalledOnce();
    // When SMTP_FROM is empty, from is set to undefined so nodemailer falls
    // back to the SMTP server's envelope-from address.
    const callArgs = sendMailMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['from']).toBeUndefined();
  });

  it('reuses the same transporter across multiple sends (lazy singleton)', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'x' });

    const send = getRealEmailTransport({
      SMTP_URL: 'smtp://localhost:25',
      SMTP_FROM: '',
    });

    await send({ to: 'a@b.com', subject: 'first', text: 'first' });
    await send({ to: 'b@c.com', subject: 'second', text: 'second' });

    // createTransport should only have been called once (lazy singleton).
    expect(createTransportMock).toHaveBeenCalledOnce();
    // sendMail called twice.
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });
});
