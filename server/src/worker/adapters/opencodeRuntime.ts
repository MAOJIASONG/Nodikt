/**
 * 文件名称：opencodeRuntime.ts
 * 文件作用：OpenCode 运行时解析模块，负责定位本地安装目录、命令脚本和隔离运行环境。
 *
 * 主要职责：
 * 1. 解析 OpenCode 安装根目录和运行时 HOME 目录。
 * 2. 构造 PATH、XDG_* 等 OpenCode 运行环境变量。
 * 3. 在 Windows 和通用 Node 环境下解析可执行命令。
 *
 * 依赖模块：
 * - fs：检测候选路径是否存在。
 * - path：处理跨平台路径拼接。
 *
 * 注意事项：
 * - 路径解析逻辑会影响默认工作器启动，变更后需验证本地命令可执行。
 * - 运行时目录应保持隔离，避免污染用户全局配置。
 */
import fs from "fs";
import path from "path";

const SERVER_ROOT = path.resolve(__dirname, "../..");
const OPEN_CODE_INSTALL_ROOT =
  process.env.OPENCODE_INSTALL_ROOT ??
  path.resolve(SERVER_ROOT, "../opencode");
const OPEN_CODE_RUNTIME_HOME =
  process.env.OPENCODE_RUNTIME_HOME ??
  path.resolve(SERVER_ROOT, ".opencode-runtime");

interface OpenCodeCommand {
  command: string;
  argsPrefix: string[];
}

function findExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function npmGlobalOpenCodeScript(): string | null {
  const appData = process.env.APPDATA;
  if (!appData) {
    return null;
  }
  return findExistingPath([
    path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode")
  ]);
}

/**
 * 函数作用：获取 OpenCode 安装根目录。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - string：OpenCode 安装目录路径。
 */
export function getOpenCodeInstallRoot(): string {
  return OPEN_CODE_INSTALL_ROOT;
}

/**
 * 函数作用：获取 OpenCode 隔离运行时 HOME 目录。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - string：运行时 HOME 目录路径。
 */
export function getOpenCodeRuntimeHome(): string {
  return OPEN_CODE_RUNTIME_HOME;
}

/**
 * 函数作用：获取 OpenCode 可执行文件目录。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - string：bin 目录路径。
 */
export function getOpenCodeBinPath(): string {
  return path.join(OPEN_CODE_INSTALL_ROOT, "bin");
}

/**
 * 函数作用：构造包含 OpenCode bin 目录的 PATH 环境变量。
 *
 * 参数说明：
 * - basePath：原始 PATH 值，默认读取当前进程 PATH。
 *
 * 返回值：
 * - string：追加 OpenCode bin 后的 PATH 字符串。
 */
export function getOpenCodePathEnv(basePath = process.env.PATH ?? ""): string {
  const npmBinPath = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null;
  return [getOpenCodeBinPath(), npmBinPath, basePath]
    .filter(Boolean)
    .join(path.delimiter);
}

/**
 * 函数作用：生成 OpenCode 本地运行所需的环境变量集合。
 *
 * 参数说明：
 * - basePath：原始 PATH 值，默认读取当前进程 PATH。
 *
 * 返回值：
 * - Record<string, string>：包含 HOME、XDG_* 和 PATH 的环境变量对象。
 */
export function getOpenCodeRuntimeEnv(basePath = process.env.PATH ?? ""): Record<string, string> {
  return {
    HOME: OPEN_CODE_RUNTIME_HOME,
    XDG_STATE_HOME: path.join(OPEN_CODE_RUNTIME_HOME, "state"),
    XDG_CONFIG_HOME: path.join(OPEN_CODE_RUNTIME_HOME, "config"),
    XDG_DATA_HOME: path.join(OPEN_CODE_RUNTIME_HOME, "data"),
    PATH: getOpenCodePathEnv(basePath)
  };
}

/**
 * 函数作用：解析可用于启动 OpenCode 的命令和参数。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - OpenCodeCommand：包含 command 和 args 的命令描述。
 *
 * 注意事项：
 * - Windows 下会优先通过当前 Node 进程执行 npm 全局脚本，避免 shim 路径不兼容。
 */
export function resolveOpenCodeCommand(): OpenCodeCommand {
  if (process.env.OPENCODE_COMMAND) {
    return { command: process.env.OPENCODE_COMMAND, argsPrefix: [] };
  }

  const binDir = getOpenCodeBinPath();
  const nodeScriptCandidates = [
    path.join(binDir, "opencode"),
    npmGlobalOpenCodeScript()
  ].filter((item): item is string => Boolean(item));

  if (process.platform === "win32") {
    const executable = findExistingPath([
      path.join(binDir, "opencode.exe"),
      path.join(binDir, "opencode.cmd"),
      path.join(binDir, "opencode.bat")
    ]);
    if (executable) {
      return { command: executable, argsPrefix: [] };
    }

    const nodeScript = findExistingPath(nodeScriptCandidates);
    if (nodeScript) {
      return { command: process.execPath, argsPrefix: [nodeScript] };
    }
  }

  const executable = findExistingPath([
    path.join(binDir, "opencode"),
    path.join(OPEN_CODE_INSTALL_ROOT, "opencode")
  ]);
  return {
    command: executable ?? path.join(binDir, process.platform === "win32" ? "opencode.cmd" : "opencode"),
    argsPrefix: []
  };
}
