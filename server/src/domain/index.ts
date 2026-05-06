/**
 * 文件名称：index.ts
 * 文件作用：领域层统一导出入口，集中暴露枚举、工具、类型和校验器。
 *
 * 主要职责：
 * 1. 为上层模块提供稳定的领域导入路径。
 * 2. 聚合 domain 目录内的公共能力。
 * 3. 降低调用方对具体领域文件路径的耦合。
 *
 * 依赖模块：
 * - enums：领域枚举。
 * - helpers：领域工具函数。
 * - types：领域类型定义。
 * - validators：领域数据校验器。
 *
 * 注意事项：
 * - 新增领域公共导出时，优先在这里统一转发。
 * - 避免在聚合入口中加入运行时代码或副作用。
 */
export * from "./enums.js";
export * from "./helpers.js";
export * from "./types.js";
export * from "./validators.js";
