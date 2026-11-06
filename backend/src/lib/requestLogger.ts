import type { DestinationStream } from 'pino';
import { pinoHttp } from 'pino-http';

// pino-http logs all headers by default, and these carry access and refresh tokens.
const SENSITIVE_LOG_PATHS = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

export function createRequestLogger(logLevel: string, destination?: DestinationStream) {
  return pinoHttp({ level: logLevel, redact: SENSITIVE_LOG_PATHS }, destination);
}
