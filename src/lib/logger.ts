import pino from 'pino';
import { config } from '@/config/index.js';

const transport =
  config.app.isDevelopment
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '{msg}',
        },
      })
    : undefined;

// pino.stdSerializers.err spreads every enumerable own property on the error
// onto the log line. That's fine for normal Errors, but Node's AbortError
// (a DOMException) carries all 25 legacy W3C error-code constants
// (INDEX_SIZE_ERR, DOMSTRING_SIZE_ERR, ...) as enumerable own properties —
// stdSerializers dumps the entire fixed list on every single occurrence,
// which is pure noise. Keep only the fields that actually vary per error.
function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  return { type: err.name, message: err.message, stack: err.stack };
}

export const logger = pino(
  {
    level: config.app.logLevel,
    base: { service: 'hylo-copilot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: serializeError,
    },
  },
  transport,
);

// Convenience child loggers — each module gets its own named child
export function createLogger(module: string) {
  return logger.child({ module });
}
