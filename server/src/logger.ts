import pino from "pino";
import path from "path";

const logLevel = process.env.LOG_LEVEL ?? "info";
const logFile = process.env.LOG_FILE ?? path.resolve(__dirname, "../logs/app.log");

export const logger = pino({
  level: logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    targets: [
      process.env.NODE_ENV === "production"
        ? {
            target: "pino/file",
            level: logLevel,
            options: { destination: 1 }
          }
        : {
            target: "pino-pretty",
            level: logLevel,
            options: {
              colorize: true,
              translateTime: "yyyy-mm-dd HH:MM:ss.l"
            }
          },
      {
        target: "pino/file",
        level: logLevel,
        options: {
          destination: logFile,
          mkdir: true
        }
      }
    ]
  }
});

export function createLogger(scope: string) {
  return logger.child({ scope });
}
