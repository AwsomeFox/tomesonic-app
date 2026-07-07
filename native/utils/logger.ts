type LogLevel = 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  tag?: string;
}

const logs: LogEntry[] = [];
const listeners: ((entry: LogEntry) => void)[] = [];

export const appLogger = {
  info: (msg: string, tag?: string) => addLog('INFO', msg, tag),
  warn: (msg: string, tag?: string) => addLog('WARN', msg, tag),
  error: (msg: string, tag?: string) => addLog('ERROR', msg, tag),
  getLogs: () => [...logs],
  clearLogs: () => {
    logs.length = 0;
  },
  addListener: (fn: (entry: LogEntry) => void) => {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};

// Redact bearer tokens/secrets at WRITE time, independent of the Logs screen's
// display-masking toggle — a user who turns masking off to share diagnostics
// must not thereby leak tokens that rode through a logged URL/header. ABS cover
// and download URLs embed `?token=...`.
function redactSecrets(message: string): string {
  try {
    return String(message)
      .replace(/([?&](?:token|access_token|refresh_token)=)[^&\s"']+/gi, "$1[REDACTED]")
      // Token chars cover base64/base64url/JWT payloads: letters, digits, and
      // . _ - + / = ~ — a narrower class left padding/opaque tails unredacted.
      .replace(/(authorization|x-refresh-token)(["']?\s*[:=]\s*["']?)(bearer\s+)?[A-Za-z0-9._+/=~-]+/gi,
        "$1$2$3[REDACTED]");
  } catch {
    return message;
  }
}

function addLog(level: LogLevel, message: string, tag?: string) {
  const entry: LogEntry = {
    level,
    message: redactSecrets(message),
    timestamp: new Date().toISOString(),
    tag,
  };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  listeners.forEach((fn) => fn(entry));
}

export type { LogLevel, LogEntry };
