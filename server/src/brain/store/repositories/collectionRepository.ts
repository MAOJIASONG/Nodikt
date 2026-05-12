/**
 * 文件名称：collectionRepository.ts
 * 文件作用：通用集合仓储模块，封装 JSON 集合文件的增删改查操作。
 *
 * 主要职责：
 * 1. 读取并校验集合文件内容。
 * 2. 提供 list、get、save、upsert、delete 等基础集合操作。
 * 3. 为不同领域实体仓储复用统一持久化逻辑。
 *
 * 依赖模块：
 * - zod：集合数据运行时校验。
 * - JsonFileStore：底层 JSON 文件读写。
 * - domain/types：集合文件结构类型。
 *
 * 注意事项：
 * - 本仓储假设集合项具备稳定 ID 字段，调用方需传入正确 idKey。
 * - 写入前应通过 schema 校验，避免损坏本地数据文件。
 */
import { ZodType } from "zod";

import { CollectionFile } from "../../../domain/types.js";
import { JsonFileStore } from "./fileStore.js";

export class CollectionRepository<TItem> {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: JsonFileStore,
    private readonly fileName: string,
    private readonly idKey: keyof TItem,
    private readonly collectionValidator?: ZodType<CollectionFile<TItem>>,
    private readonly itemValidator?: ZodType<TItem>
  ) {}

  private async loadUnchecked(): Promise<CollectionFile<TItem>> {
    const collection = await this.store.readCollection<TItem>(this.fileName);
    return this.collectionValidator ? this.collectionValidator.parse(collection) : collection;
  }

  private enqueueMutation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async saveAllUnchecked(items: TItem[]): Promise<void> {
    if (this.itemValidator) {
      items.forEach((item) => this.itemValidator!.parse(item));
    }
    await this.store.writeCollection(this.fileName, {
      version: "v1",
      updated_at: new Date(0).toISOString(),
      items
    });
  }

  /**
   * 函数作用：读取并校验完整集合文件。
   *
   * 参数说明：
   * - 无。
   *
   * 返回值：
   * - Promise<CollectionFile<TItem>>：集合文件结构和实体列表。
   */
  async load(): Promise<CollectionFile<TItem>> {
    await this.mutationQueue;
    return this.loadUnchecked();
  }

  /**
   * 函数作用：读取集合中的全部实体。
   *
   * 参数说明：
   * - 无。
   *
   * 返回值：
   * - Promise<TItem[]>：实体列表。
   */
  async list(): Promise<TItem[]> {
    const collection = await this.load();
    return collection.items;
  }

  /**
   * 函数作用：根据 ID 查询单个实体。
   *
   * 参数说明：
   * - id：实体唯一 ID。
   *
   * 返回值：
   * - Promise<TItem | undefined>：找到时返回实体，否则返回 undefined。
   */
  async getById(id: string): Promise<TItem | undefined> {
    const items = await this.list();
    return items.find((item) => String((item as Record<string, unknown>)[String(this.idKey)]) === id);
  }

  /**
   * 函数作用：覆盖保存集合中的全部实体。
   *
   * 参数说明：
   * - items：新的完整实体列表。
   *
   * 返回值：
   * - Promise<void>：写入完成后无返回数据。
   *
   * 注意事项：
   * - 本函数会进入写入队列，避免同一集合并发写入互相覆盖。
   */
  async saveAll(items: TItem[]): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.saveAllUnchecked(items);
    });
  }

  /**
   * 函数作用：按 ID 新增或更新单个实体。
   *
   * 参数说明：
   * - item：需要写入的实体。
   *
   * 返回值：
   * - Promise<void>：写入完成后无返回数据。
   */
  async upsert(item: TItem): Promise<void> {
    await this.enqueueMutation(async () => {
      if (this.itemValidator) {
        this.itemValidator.parse(item);
      }
      const items = (await this.loadUnchecked()).items;
      const id = (item as Record<string, unknown>)[String(this.idKey)];
      const nextItems = items.filter((existing) => {
        return (existing as Record<string, unknown>)[String(this.idKey)] !== id;
      });
      nextItems.push(item);
      await this.saveAllUnchecked(nextItems);
    });
  }

  /**
   * 函数作用：按 ID 删除单个实体。
   *
   * 参数说明：
   * - id：需要删除的实体 ID。
   *
   * 返回值：
   * - Promise<void>：删除完成后无返回数据。
   */
  async delete(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const items = (await this.loadUnchecked()).items;
      await this.saveAllUnchecked(
        items.filter((item) => String((item as Record<string, unknown>)[String(this.idKey)]) !== id)
      );
    });
  }
}
