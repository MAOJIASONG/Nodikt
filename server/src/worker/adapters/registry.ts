/**
 * 文件名称：registry.ts
 * 文件作用：工作器适配器注册表，维护工作器注册信息与具体适配器实例之间的映射。
 *
 * 主要职责：
 * 1. 注册和注销工作器适配器。
 * 2. 按 worker_id 查找工作器运行时实现。
 * 3. 为调度器和运维监控提供当前可用工作器列表。
 *
 * 依赖模块：
 * - domain：工作器注册类型。
 * - worker/adapters/contract：适配器接口定义。
 *
 * 注意事项：
 * - 注册表是内存状态，进程重启后需由启动流程从仓储重建。
 * - worker_id 必须保持唯一，避免派发任务落到错误适配器。
 */
import { WorkerRegistration } from "../../domain/index.js";

import { WorkerAdapter } from "./contract.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, WorkerAdapter>();
  private readonly executionAdapter = new Map<string, WorkerAdapter>();
  private readonly workers = new Map<string, WorkerRegistration>();

  /**
   * 函数作用：注册工作器及其适配器实例。
   *
   * 参数说明：
   * - workerId：工作器唯一 ID。
   * - worker：工作器注册信息。
   * - adapter：负责该工作器运行时操作的适配器。
   *
   * 返回值：
   * - void：注册结果写入内存映射。
   */
  registerAdapter(workerId: string, worker: WorkerRegistration, adapter: WorkerAdapter): void {
    this.adapters.set(workerId, adapter);
    this.workers.set(workerId, worker);
  }

  /**
   * 函数作用：按工作器 ID 查找适配器实例。
   *
   * 参数说明：
   * - workerId：工作器唯一 ID。
   *
   * 返回值：
   * - WorkerAdapter | undefined：存在时返回适配器，否则返回 undefined。
   */
  getAdapter(workerId: string): WorkerAdapter | undefined {
    return this.adapters.get(workerId);
  }

  /**
   * 函数作用：绑定执行 ID 与工作器 ID。
   *
   * 参数说明：
   * - executionId：执行记录 ID。
   * - workerId：承担该执行的工作器 ID。
   *
   * 返回值：
   * - void：绑定关系写入内存映射。
   */
  bindExecution(executionId: string, workerId: string): void {
    const adapter = this.adapters.get(workerId);
    if (!adapter) {
      throw new Error(`Missing adapter for worker ${workerId}`);
    }
    this.executionAdapter.set(executionId, adapter);
  }

  /**
   * 函数作用：根据执行 ID 查找对应工作器适配器。
   *
   * 参数说明：
   * - executionId：执行记录 ID。
   *
   * 返回值：
   * - WorkerAdapter | undefined：找到绑定工作器时返回适配器，否则返回 undefined。
   */
  getExecutionAdapter(executionId: string): WorkerAdapter | undefined {
    return this.executionAdapter.get(executionId);
  }

  /**
   * 函数作用：读取工作器注册信息。
   *
   * 参数说明：
   * - workerId：工作器唯一 ID。
   *
   * 返回值：
   * - WorkerRegistration | undefined：存在时返回工作器信息，否则返回 undefined。
   */
  getWorker(workerId: string): WorkerRegistration | undefined {
    return this.workers.get(workerId);
  }
}
