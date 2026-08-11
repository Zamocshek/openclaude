import { describe, expect, test } from 'bun:test'
import {
  buildWebSessionCookie,
  clearWebSessionCookie,
  constantTimeSecretEqual,
  issueWebSession,
  isLoopbackWebRequest,
  validateWebSessionMutation,
  verifyWebSessionToken,
  WEB_SESSION_COOKIE_NAME,
} from './webSessionAuth.js'

describe('web session auth', () => {
  test('issues an opaque expiring token invalidated by API-key rotation', () => {
    const session = issueWebSession('admin-key', { now: 1_000, ttlMs: 300_000 })

    expect(session.token).not.toContain('admin-key')
    expect(verifyWebSessionToken(session.token, 'admin-key', 2_000)).toMatchObject({
      version: 1,
      csrfToken: session.csrfToken,
    })
    expect(verifyWebSessionToken(session.token, 'rotated-key', 2_000)).toBeUndefined()
    expect(verifyWebSessionToken(session.token, 'admin-key', session.expiresAt)).toBeUndefined()
  })

  test('rejects tampering and validates mutation CSRF', () => {
    const session = issueWebSession('admin-key')
    const payload = verifyWebSessionToken(session.token, 'admin-key')!

    expect(verifyWebSessionToken(`${session.token}x`, 'admin-key')).toBeUndefined()
    expect(validateWebSessionMutation({ method: 'GET', headers: {} }, payload)).toBeUndefined()
    expect(validateWebSessionMutation({ method: 'POST', headers: {} }, payload)).toBe(
      'Invalid UI session CSRF token',
    )
    expect(validateWebSessionMutation({
      method: 'POST',
      headers: {
        host: 'localhost:8642',
        origin: 'http://localhost:8642',
        'x-csrf-token': session.csrfToken,
      },
    }, payload)).toBeUndefined()
  })

  test('creates HttpOnly strict cookies and recognizes loopback hosts', () => {
    const cookie = buildWebSessionCookie('opaque', { secure: true })
    expect(cookie).toContain(`${WEB_SESSION_COOKIE_NAME}=opaque`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(clearWebSessionCookie()).toContain('Max-Age=0')
    expect(isLoopbackWebRequest({ headers: { host: '127.0.0.1:8642' } })).toBe(true)
    expect(isLoopbackWebRequest({ headers: { host: '[::1]:8642' } })).toBe(true)
    expect(isLoopbackWebRequest({ headers: { host: 'agent.example.com' } })).toBe(false)
  })

  test('compares secrets without type coercion', () => {
    expect(constantTimeSecretEqual('secret', 'secret')).toBe(true)
    expect(constantTimeSecretEqual('secret', 'Secret')).toBe(false)
    expect(constantTimeSecretEqual('short', 'longer')).toBe(false)
  })
})
