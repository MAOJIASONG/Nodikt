/**
 * 文件名称：contract.ts
 * 文件作用：工作器适配器契约定义，声明调度系统与不同工作器运行时之间的统一接口。
 *
 * 主要职责：
 * 1. 约束工作器注册、注销、派发、取消和心跳读取方法。
 * 2. 屏蔽 Codex、OpenCode 等具体运行时差异。
 * 3. 为适配器注册表和调度器提供统一调用面。
 *
 * 依赖模块：
 * - domain：工作器注册、派发、心跳和结果类型。
 *
 * 注意事项：
 * - 接口变更会影响所有工作器适配器实现。
 * - 新增适配器能力时，应优先保持向后兼容。
 */
import { WorkerDispatchPacket, WorkerHeartbeat, WorkerRegistration, WorkerResult } from "../../domain/index.js";

export interface WorkerAdapter {
  register(config: WorkerRegistration): Promise<WorkerRegistration>;
  startExecution(packet: WorkerDispatchPacket): Promise<void>;
  stopExecution(executionId: string): Promise<void>;
  pollStatus(executionId: string): Promise<WorkerHeartbeat | null>;
  collectResult(executionId: string): Promise<WorkerResult | null>;
  healthCheck(workerId: string): Promise<{ ok: boolean; message: string }>;
}
