/**
 * 文件名称：index.ts
 * 文件作用：工作器适配器统一导出入口，集中暴露适配器契约、实现和注册表。
 *
 * 主要职责：
 * 1. 聚合 Codex、OpenCode 和注册表相关导出。
 * 2. 为应用装配层提供简洁导入路径。
 * 3. 降低调用方对适配器目录结构的依赖。
 *
 * 依赖模块：
 * - contract：适配器接口定义。
 * - codexAdapter：Codex 适配器。
 * - opencodeAdapter：OpenCode 适配器。
 * - registry：适配器注册表。
 *
 * 注意事项：
 * - 本文件只做导出聚合，不应加入运行时副作用。
 */
export * from "./contract.js";
export * from "./codexAdapter.js";
export * from "./opencodeAdapter.js";
export * from "./claudeCodeAdapter.js";
export * from "./registry.js";
