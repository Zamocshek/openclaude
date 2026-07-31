export function redactAgentText(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(
      /(\bsshpass\b[^\r\n]*?\s-p(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[REDACTED_PASSWORD]',
    )
    .replace(
      /(\bcurl\b[^\r\n]*?\s(?:-u|--user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[REDACTED_CREDENTIALS]',
    )
    .replace(
      /((?:^|[\s;])--?(?:password|passwd|token|api[-_]?key|secret|client[-_]?secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(
      /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(\b(?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD|TOKEN|API_KEY|SECRET|CLIENT_SECRET|AUTHORIZATION|PRIVATE_KEY)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(\b(?:SSHPASS|PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/giu,
      '$1[REDACTED]@',
    )
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bs2_[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]')
    .replace(
      /(\bbot)\d{6,14}:AA[A-Za-z0-9_-]{20,}\b/giu,
      '$1[REDACTED_TELEGRAM_TOKEN]',
    )
    .replace(/\b\d{6,14}:AA[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/\b(api[_-]?key|token|authorization)\s*[:=]\s*["']?[^"',\s]{8,}/gi, '$1=[REDACTED]')
}
