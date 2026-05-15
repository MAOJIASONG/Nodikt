/**
 * 文件名称：logTransport.ts
 * 文件作用：pino 自定义控制台 transport，在 worker 线程中运行。
 *
 * 主要职责：
 * 1. 将 pino NDJSON 流格式化为可读的彩色文本输出。
 * 2. 将 UTC 时间戳转换为本机本地时间。
 * 3. 在主要流程阶段前后插入空行，增强可读性。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const { once } = require("events");

const RESET  = "\x1b[0m";
const DIM    = "\x1b[2m";
const BOLD   = "\x1b[1m";
const cINFO  = "\x1b[36m";  // cyan
const cWARN  = "\x1b[33m";  // yellow
const cERROR = "\x1b[31m";  // red
const cDEBUG = "\x1b[90m";  // gray

type TransportOptions = {
  destination?: string | number;
  mkdir?: boolean;
  colorize?: boolean;
  blankLines?: boolean;
};

// 大步骤起点：输出前插入空行
const BEFORE_BLANK = new Set([
  "收到用户输入事件",
  "开始澄清初始需求",
  "正在使用用户回复继续澄清需求",
  "需求澄清已完成，准备请求初始规划",
  "正在生成前沿计划",
  "子目标已标记为就绪",
  "正在保存已创建的执行",
  "正在启动工作器执行",
  "开始验证工作器结果",
  "正在归并验证结果",
  "正在保存决策请求",
  "正在处理决策响应",
  "需求已恢复，准备请求重新规划",
  "→ LLM 请求",
]);

// 大步骤终点：输出后插入空行
const AFTER_BLANK = new Set([
  "初始需求仍需要用户补充澄清",
  "初始需求澄清已完成",
  "澄清回复仍需要更多用户输入",
  "澄清回复已接受",
  "已将生成计划保存到需求",
  "前沿计划已生成",
  "子目标已创建",
  "已为就绪子目标创建执行",
  "工作器执行已启动",
  "LLM 验证完成",
  "降级验证完成",
  "验证归并结果已保存",
  "验证后准备请求重新规划",
  "验证结果已完成任务",
  "已根据验证结果创建决策请求",
  "决策对话已更新",
  "决策指导已接受，准备请求重新规划",
  "决策请求暂停需求",
  "决策请求取消需求",
  "决策已解决，准备请求重新规划",
  "需求已暂停",
  "需求已取消",
  "任务已完成",
  "← LLM 响应",
  "← LLM 请求失败",
]);

function toLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}

function levelTag(n: number): [string, string] {
  if (n >= 50) return [cERROR, "ERROR"];
  if (n >= 40) return [cWARN,  "WARN "];
  if (n >= 30) return [cINFO,  "INFO "];
  return         [cDEBUG, "DEBUG"];
}

const SKIP_KEYS = new Set(["level", "time", "scope", "msg", "pid", "hostname", "v"]);

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") {
    return v.length > 400 ? v.slice(0, 400) + "…" : v;
  }
  if (typeof v !== "object") return String(v);
  const s = JSON.stringify(v);
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

function color(enabled: boolean, code: string): string {
  return enabled ? code : "";
}

function render(obj: Record<string, unknown>, options: Required<Pick<TransportOptions, "colorize" | "blankLines">>): string {
  const msg   = String(obj.msg ?? "");
  const time  = obj.time ? toLocalTime(String(obj.time)) : " ".repeat(23);
  const [col, lvl] = levelTag(Number(obj.level ?? 30));
  const scope = String(obj.scope ?? "");
  const dim = color(options.colorize, DIM);
  const bold = color(options.colorize, BOLD);
  const reset = color(options.colorize, RESET);
  const levelColor = color(options.colorize, col);

  const extras: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    const display =
      k === "err" && v && typeof v === "object"
        ? String((v as any).message ?? JSON.stringify(v))
        : fmtVal(v);
    extras.push(`${dim}${k}${reset}: ${display}`);
  }

  const lines: string[] = [];

  if (options.blankLines && BEFORE_BLANK.has(msg)) lines.push("");

  const scopePart = scope ? `${dim}[${scope}]${reset}` : "";
  lines.push(`${dim}${time}${reset}  ${levelColor}${bold}${lvl}${reset}  ${scopePart}  ${msg}`);

  // 每行两个字段，保持紧凑
  for (let i = 0; i < extras.length; i += 2) {
    lines.push(`    ${extras.slice(i, i + 2).join("    ")}`);
  }

  if (options.blankLines && AFTER_BLANK.has(msg)) lines.push("");

  return lines.join("\n") + "\n";
}

function createDestination(opts: TransportOptions) {
  if (opts.destination === undefined || opts.destination === 1) {
    return process.stdout;
  }

  if (typeof opts.destination !== "string") {
    throw new Error(`Unsupported log destination: ${String(opts.destination)}`);
  }

  if (opts.mkdir) {
    fs.mkdirSync(path.dirname(opts.destination), { recursive: true });
  }

  return fs.createWriteStream(opts.destination, { flags: "a", encoding: "utf8" });
}

const build: any = require("pino-abstract-transport");

// pino 加载 transport 时期望导出一个函数（工厂），调用后返回 stream
export = function(opts: TransportOptions = {}) {
  const destination = createDestination(opts);
  const renderOptions = {
    colorize: opts.colorize ?? (opts.destination === undefined || opts.destination === 1),
    blankLines: opts.blankLines ?? true
  };

  return build(async function(source: AsyncIterable<Record<string, unknown>>) {
    for await (const obj of source) {
      try {
        if (!destination.write(render(obj, renderOptions))) {
          await once(destination, "drain");
        }
      } catch {
        // transport 不能因格式化异常崩溃
      }
    }
    if (destination !== process.stdout) {
      destination.end();
    }
  });
};
