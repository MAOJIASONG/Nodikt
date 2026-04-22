import { promises as fs } from "fs";
import path from "path";

import { nowIso } from "../domain/helpers.js";
import { CollectionFile } from "../domain/types.js";

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

  async readCollection<TItem>(fileName: string): Promise<CollectionFile<TItem>> {
    await this.waitForPendingWrite(fileName);
    const filePath = path.join(this.baseDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as CollectionFile<TItem>;
  }

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

  async readObject<TObject>(fileName: string): Promise<TObject> {
    await this.waitForPendingWrite(fileName);
    const filePath = path.join(this.baseDir, fileName);
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TObject;
  }

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
