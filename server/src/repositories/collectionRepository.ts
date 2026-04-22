import { ZodType } from "zod";

import { CollectionFile } from "../domain/types.js";
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

  async load(): Promise<CollectionFile<TItem>> {
    await this.mutationQueue;
    return this.loadUnchecked();
  }

  async list(): Promise<TItem[]> {
    const collection = await this.load();
    return collection.items;
  }

  async getById(id: string): Promise<TItem | undefined> {
    const items = await this.list();
    return items.find((item) => String((item as Record<string, unknown>)[String(this.idKey)]) === id);
  }

  async saveAll(items: TItem[]): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.saveAllUnchecked(items);
    });
  }

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

  async delete(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const items = (await this.loadUnchecked()).items;
      await this.saveAllUnchecked(
        items.filter((item) => String((item as Record<string, unknown>)[String(this.idKey)]) !== id)
      );
    });
  }
}
