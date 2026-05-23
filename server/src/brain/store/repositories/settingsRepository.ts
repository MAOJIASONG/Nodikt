/**
 * 文件名称：settingsRepository.ts
 * 文件作用：系统设置仓储模块，负责读取和保存单例 settings 配置。
 *
 * 主要职责：
 * 1. 从 JSON 文件中读取系统设置。
 * 2. 使用 schema 校验设置结构。
 * 3. 保存更新后的设置并维持集合文件格式。
 *
 * 依赖模块：
 * - zod：设置数据校验。
 * - JsonFileStore：底层 JSON 文件读写。
 * - domain/types：Settings 类型定义。
 *
 * 注意事项：
 * - settings 是单例配置，保存时需保留未知兼容字段时应谨慎处理。
 * - 模型配置、工作区路径等关键字段变更会影响运行时行为。
 */
import { ZodType, ZodTypeDef } from "zod";

import { Settings } from "../../../domain/types.js";
import { JsonFileStore } from "./fileStore.js";

// E-T1：放宽 Input 泛型，让 settingsSchema 中带 .default() 的字段（如 llm_timeout_seconds）
// 在 input 类型里可缺省。Output 仍是完整 Settings。
export class SettingsRepository {
  constructor(
    private readonly store: JsonFileStore,
    private readonly fileName: string,
    private readonly validator?: ZodType<Settings, ZodTypeDef, any>
  ) {}

  /**
   * 函数作用：读取并校验系统设置。
   *
   * 参数说明：
   * - 无。
   *
   * 返回值：
   * - Promise<Settings>：当前系统设置。
   */
  async load(): Promise<Settings> {
    const settings = await this.store.readObject<Settings>(this.fileName);
    return this.validator ? this.validator.parse(settings) : settings;
  }

  /**
   * 函数作用：保存系统设置。
   *
   * 参数说明：
   * - settings：需要持久化的系统设置。
   *
   * 返回值：
   * - Promise<void>：保存完成后无返回数据。
   */
  async save(settings: Settings): Promise<void> {
    if (this.validator) {
      this.validator.parse(settings);
    }
    await this.store.writeObject(this.fileName, settings);
  }
}
