import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const isProd = process.env.NODE_ENV === 'production';
let currentLevel = process.env.LOG_LEVEL || 'info';

// Disable debug logs in production to optimize logging
if (isProd && currentLevel === 'debug') {
  currentLevel = 'info';
}

/**
 * In production, suppress noisy initialization logs (XXX created, XXX initialized).
 * These are useful for debugging but clutter production logs on every restart.
 */
const suppressInitLogs = winston.format((info) => {
  if (!isProd) return info;
  if (info.level === 'info' && typeof info.message === 'string') {
    if (/\b(created|initialized)\b/i.test(info.message) &&
        !/\bCreated (config snapshot|scheduled task|fault pattern|operational rule|pre-remediation|pre-restore|default template|Skill )/i.test(info.message)) {
      return false; // suppress
    }
  }
  return info;
});

export const logger = winston.createLogger({
  level: currentLevel,
  format: combine(
    suppressInitLogs(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
      tailable: true
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 20 * 1024 * 1024, // 20MB
      maxFiles: 3,
      tailable: true
    })
  ]
});
