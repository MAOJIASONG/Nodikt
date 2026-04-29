import { spawn, ChildProcessByStdio } from "child_process";
import { readdir, stat } from "fs/promises";
import { Readable } from "stream";

import {
  createId,
  WorkerDispatchPacket,
  WorkerExecutionStatus,
  WorkerHeartbeat,
  WorkerRegistration,
  WorkerResult,
  WorkerResultStatus,
  nowIso
} from "../domain/index.js";
import { WorkerAdapter } from "./contract.js";

interface RuntimeRecord {
  workerId: string;
  cwd: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: number;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
}

export abstract class BaseLocalCommandAdapter implements WorkerAdapter {
  protected readonly runtimeByExecution = new Map<string, RuntimeRecord>();
  protected readonly workerConfigs = new Map<string, WorkerRegistration>();

  private stripAnsi(input: string): string {
    return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  }

  private summarizeText(input: string, maxLength = 280): string {
    const clean = this.stripAnsi(input).replace(/\s+/g, " ").trim();
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
  }

  private getLastLine(lines: string[]): string | null {
    if (lines.length === 0) {
      return null;
    }
    const merged = lines[lines.length - 1]
      .split(/\r?\n/)
      .map((line) => this.summarizeText(line))
      .filter(Boolean);
    return merged.length > 0 ? merged[merged.length - 1] : null;
  }

  private async hasRecentWorkspaceChanges(root: string, startedAt: number, depth = 4): Promise<boolean> {
    if (depth < 0) {
      return false;
    }

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = `${root}/${entry.name}`;
      try {
        const details = await stat(fullPath);
        if (details.isFile() && details.mtimeMs >= startedAt) {
          return true;
        }
        if (details.isDirectory() && await this.hasRecentWorkspaceChanges(fullPath, startedAt, depth - 1)) {
          return true;
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  async register(config: WorkerRegistration): Promise<WorkerRegistration> {
    this.workerConfigs.set(config.worker_id, config);
    return config;
  }

  async startExecution(packet: WorkerDispatchPacket): Promise<void> {
    const worker = this.workerConfigs.get(packet.worker_id);
    if (!worker) {
      throw new Error(`Worker ${packet.worker_id} is not registered`);
    }

    const { command, args, env, cwd } = this.resolveCommand(worker, packet);
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const record: RuntimeRecord = {
      workerId: packet.worker_id,
      cwd,
      process: child,
      startedAt: Date.now(),
      stdout: [],
      stderr: [],
      exitCode: null,
      finishedAt: null,
      errorMessage: null
    };

    child.stdout.on("data", (chunk: Buffer) => {
      record.stdout.push(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      record.stderr.push(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      record.errorMessage = error.message;
      record.stderr.push(error.message);
      record.finishedAt = Date.now();
    });
    child.on("close", (exitCode) => {
      record.exitCode = exitCode;
      record.finishedAt = Date.now();
    });

    this.runtimeByExecution.set(packet.execution_id, record);
  }

  async stopExecution(executionId: string): Promise<void> {
    const runtime = this.runtimeByExecution.get(executionId);
    runtime?.process.kill("SIGTERM");
  }

  async pollStatus(executionId: string): Promise<WorkerHeartbeat | null> {
    const runtime = this.runtimeByExecution.get(executionId);
    if (!runtime) {
      return null;
    }

    const status = runtime.finishedAt === null
      ? WorkerExecutionStatus.RUNNING
      : runtime.exitCode === 0
        ? WorkerExecutionStatus.IDLE
        : WorkerExecutionStatus.ERROR;

    return {
      schema_version: "v1",
      worker_id: runtime.workerId,
      execution_id: executionId,
      status,
      progress_note: this.getLastLine(runtime.stdout) || this.getLastLine(runtime.stderr),
      source: runtime.stdout.length > 0 || runtime.stderr.length > 0 ? "event_stream" : "status_poll",
      emitted_at: nowIso(),
      adapter_meta: {
        runtime_ms: Date.now() - runtime.startedAt
      }
    };
  }

  async collectResult(executionId: string): Promise<WorkerResult | null> {
    const runtime = this.runtimeByExecution.get(executionId);
    if (!runtime || runtime.finishedAt === null) {
      return null;
    }
    const producedArtifacts = runtime.exitCode === 0 && await this.hasRecentWorkspaceChanges(runtime.cwd, runtime.startedAt)
      ? [
          {
            artifact_id: createId("artifact"),
            artifact_type: "file_bundle" as const,
            backend: "filesystem" as const,
            uri: runtime.cwd,
            metadata: {
              execution_id: executionId
            },
            created_at: nowIso()
          }
        ]
      : [];

    return {
      schema_version: "v1",
      execution_id: executionId,
      worker_id: runtime.workerId,
      worker_status: this.mapExitCode(runtime.exitCode, runtime.stdout.join(""), runtime.stderr.join("")),
      claimed_outcome: this.getLastLine(runtime.stdout),
      compressed_history: this.summarizeText([...runtime.stdout, ...runtime.stderr].join(""), 5000),
      produced_artifacts: producedArtifacts,
      blocker_reason: runtime.exitCode === 0
        ? null
        : {
            code: "PROCESS_EXIT",
            message: runtime.errorMessage
              || runtime.stderr.join("").slice(-1000)
              || `Process exited with code ${runtime.exitCode}`
          },
      suggested_next_step: runtime.exitCode === 0 ? "Verify produced artifacts" : "Inspect stderr and retry or request human decision",
      budget_used: {
        duration_ms: runtime.finishedAt - runtime.startedAt
      },
      adapter_meta: {
        exit_code: runtime.exitCode
      },
      returned_at: nowIso()
    };
  }

  async healthCheck(workerId: string): Promise<{ ok: boolean; message: string }> {
    const worker = this.workerConfigs.get(workerId);
    if (!worker) {
      return { ok: false, message: "Worker not registered" };
    }
    return { ok: true, message: `Worker ${worker.name} configured` };
  }

  protected mapExitCode(exitCode: number | null, stdout: string, stderr: string): WorkerResultStatus {
    if (exitCode === 0 && stdout.trim().length > 0) {
      return WorkerResultStatus.DONE;
    }
    if (exitCode === 0) {
      return WorkerResultStatus.PARTIAL;
    }
    const merged = `${stdout}\n${stderr}`.toLowerCase();
    if (merged.includes("permission") || merged.includes("blocked")) {
      return WorkerResultStatus.BLOCKED;
    }
    if (merged.includes("need") && merged.includes("info")) {
      return WorkerResultStatus.NEED_HELP;
    }
    return WorkerResultStatus.FAILED;
  }

  protected abstract resolveCommand(
    worker: WorkerRegistration,
    packet: WorkerDispatchPacket
  ): {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  };
}
