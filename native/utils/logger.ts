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

function addLog(level: LogLevel, message: string, tag?: string) {
  const entry: LogEntry = { level, message, timestamp: new Date().toISOString(), tag };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  listeners.forEach((fn) => fn(entry));
}

export type { LogLevel, LogEntry };
