import { ZodType } from "zod";

import { Settings } from "../domain/types.js";
import { JsonFileStore } from "./fileStore.js";

export class SettingsRepository {
  constructor(
    private readonly store: JsonFileStore,
    private readonly fileName: string,
    private readonly validator?: ZodType<Settings>
  ) {}

  async load(): Promise<Settings> {
    const settings = await this.store.readObject<Settings>(this.fileName);
    return this.validator ? this.validator.parse(settings) : settings;
  }

  async save(settings: Settings): Promise<void> {
    if (this.validator) {
      this.validator.parse(settings);
    }
    await this.store.writeObject(this.fileName, settings);
  }
}
