const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])

const RETRYABLE_MESSAGE_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network request failed/i,
  /failed to fetch/i,
  /network is unreachable/i,
  /connection reset/i,
  /connection refused/i,
  /temporarily unavailable/i,
  /unable to resolve host/i,
  /could not connect/i,
  /offline/i,
  /dns/i
]

const PERMANENT_AUTH_MESSAGE_PATTERNS = [
  /invalid token/i,
  /token invalid/i,
  /expired token/i,
  /token expired/i,
  /invalid refresh/i,
  /refresh token.*(missing|invalid|expired|revoked)/i,
  /invalid_grant/i,
  /unauthorized/i,
  /forbidden/i,
  /authentication failed/i,
  /no refresh token/i,
  /oldauthtoken/i
]

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function extractStatusCode(error) {
  return (
    toNumber(error?.statusCode) ||
    toNumber(error?.status) ||
    toNumber(error?.code) ||
    toNumber(error?.response?.status) ||
    null
  )
}

export function extractErrorCode(error) {
  const code = error?.errorCode ?? error?.code
  if (code === undefined || code === null) return null
  return String(code)
}

export function extractErrorMessage(error) {
  const raw = error?.message || error?.error || error?.responseData || error?.response?.data || ''
  if (typeof raw === 'string') return raw
  try {
    return JSON.stringify(raw)
  } catch (err) {
    return String(raw)
  }
}

export function classifyAuthFailure(error) {
  const statusCode = extractStatusCode(error)
  const code = extractErrorCode(error)
  const message = extractErrorMessage(error)

  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: 'permanent-auth',
      isRetryable: false,
      reason: `http-${statusCode}`,
      statusCode,
      code,
      message
    }
  }

  if (statusCode !== null && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return {
      kind: 'transient-network',
      isRetryable: true,
      reason: `http-${statusCode}`,
      statusCode,
      code,
      message
    }
  }

  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return {
      kind: 'permanent-auth',
      isRetryable: false,
      reason: `http-${statusCode}`,
      statusCode,
      code,
      message
    }
  }

  if (RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      kind: 'transient-network',
      isRetryable: true,
      reason: 'retryable-message',
      statusCode,
      code,
      message
    }
  }

  if (PERMANENT_AUTH_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      kind: 'permanent-auth',
      isRetryable: false,
      reason: 'permanent-auth-message',
      statusCode,
      code,
      message
    }
  }

  if (code && /^NSURLError/i.test(code)) {
    return {
      kind: 'transient-network',
      isRetryable: true,
      reason: `code-${code}`,
      statusCode,
      code,
      message
    }
  }

  return {
    kind: 'transient-network',
    isRetryable: true,
    reason: 'default-transient',
    statusCode,
    code,
    message
  }
}

export function isRetryableAuthFailure(error) {
  return classifyAuthFailure(error).isRetryable
}

export function isPermanentAuthFailure(error) {
  return !classifyAuthFailure(error).isRetryable
}
