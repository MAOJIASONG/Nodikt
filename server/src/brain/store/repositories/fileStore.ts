/**
 * 文件名称：fileStore.ts
 * 文件作用：JSON 文件存储模块，负责本地数据文件的初始化、读取、写入和备份。
 *
 * 主要职责：
 * 1. 确保数据目录和集合文件存在。
 * 2. 读取 JSON 文件并返回解析后的集合结构。
 * 3. 写入集合数据并维护更新时间。
 * 4. 在需要时生成数据备份文件。
 *
 * 依赖模块：
 * - fs/promises：异步文件系统操作。
 * - path：数据文件路径处理。
 * - domain/helpers：时间戳工具。
 *
 * 注意事项：
 * - 本模块是本地持久化边界，写入逻辑应避免破坏已有数据结构。
 * - 数据格式变化时，需要考虑旧 JSON 文件的兼容或迁移。
 */
import { promises as fs } from "fs";
import path from "path";

import { nowIso } from "../../../domain/helpers.js";
import { CollectionFile } from "../../../domain/types.js";

export class JsonFileStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string) {}

  private async waitForPendingWrite(fileName: string): Promise<void> {
    await (this.writeQueues.get(fileName) ?? Promise.resolve());
  }

  private async writeAtomically(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  }

  private async queueWrite(fileName: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(fileName) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(fileName, next);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(fileName) === next) {
        this.writeQueues.delete(fileName);
      }
    }
  }

  /**
   * 函数作用：读取 JSON 集合文件。
   *
   * 参数说明：
   * - fileName：数据目录下的集合文件名。
   *
   * 返回值：
   * - Promise<CollectionFile<TItem>>：解析后的集合结构。
   */
  async readCollection<TItem>(fileName: string): Promise<CollectionFile<TItem>> {
    await this.waitForPendingWrite(fileName);
    const filePath = path.join(this.baseDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as CollectionFile<TItem>;
  }

  /**
   * 函数作用：写入 JSON 集合文件。
   *
   * 参数说明：
   * - fileName：数据目录下的集合文件名。
   * - collection：需要写入的集合数据。
   *
   * 返回值：
   * - Promise<void>：写入完成后无返回数据。
   *
   * 注意事项：
   * - 写入会自动刷新 updated_at，并通过临时文件完成原子替换。
   */
  async writeCollection<TItem>(fileName: string, collection: CollectionFile<TItem>): Promise<void> {
    const filePath = path.join(this.baseDir, fileName);
    const next = {
      ...collection,
      updated_at: nowIso()
    };
    await this.queueWrite(fileName, async () => {
      await this.writeAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  /**
   * 函数作用：读取单对象 JSON 文件。
   *
   * 参数说明：
   * - fileName：数据目录下的对象文件名。
   *
   * 返回值：
   * - Promise<TObject>：解析后的对象。
   */
  async readObject<TObject>(fileName: string): Promise<TObject> {
    await this.waitForPendingWrite(fileName);
    const filePath = path.join(this.baseDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TObject;
  }

  /**
   * 函数作用：写入单对象 JSON 文件。
   *
   * 参数说明：
   * - fileName：数据目录下的对象文件名。
   * - value：需要写入的对象，必须包含 updated_at 字段。
   *
   * 返回值：
   * - Promise<void>：写入完成后无返回数据。
   */
  async writeObject<TObject extends { updated_at: string }>(fileName: string, value: TObject): Promise<void> {
    const filePath = path.join(this.baseDir, fileName);
    await this.queueWrite(fileName, async () => {
      await this.writeAtomically(
        filePath,
        `${JSON.stringify({ ...value, updated_at: nowIso() }, null, 2)}\n`
      );
    });
  }
}
