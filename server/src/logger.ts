/**
 * 文件名称：logger.ts
 * 文件作用：统一日志模块，负责创建后端全局 logger 和按作用域派生的子 logger。
 *
 * 主要职责：
 * 1. 根据环境变量配置日志等级和日志文件路径。
 * 2. 同时输出控制台日志和文件日志。
 * 3. 提供 createLogger 方法，为不同模块添加 scope 标识。
 *
 * 依赖模块：
 * - pino：结构化日志库。
 * - pino-pretty：开发环境控制台日志格式化。
 *
 * 注意事项：
 * - 生产环境应优先使用结构化日志输出，便于采集与检索。
 * - 业务模块应通过 createLogger 创建带作用域的 logger。
 */
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

/**
 * 函数作用：创建带业务作用域标识的子 logger。
 *
 * 参数说明：
 * - scope：日志作用域名称，通常使用模块名或功能名。
 *
 * 返回值：
 * - 返回 pino child logger，日志中会自动携带 scope 字段。
 *
 * 注意事项：
 * - 业务模块优先使用本函数，便于按模块筛选日志。
 */
export function createLogger(scope: string) {
  return logger.child({ scope });
}
