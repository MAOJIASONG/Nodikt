import path from "path";

import { WorkerDispatchPacket, WorkerRegistration } from "../../domain/index.js";
import { BaseLocalCommandAdapter } from "./baseLocalCommandAdapter.js";

const OPEN_CODE_INSTALL_ROOT =
  process.env.OPENCODE_INSTALL_ROOT ??
  path.resolve(process.cwd(), "../opencode");
const OPEN_CODE_RUNTIME_HOME =
  process.env.OPENCODE_RUNTIME_HOME ??
  path.resolve(process.cwd(), ".opencode-runtime");

export class OpenCodeAdapter extends BaseLocalCommandAdapter {
  private readWorkspaceRoot(packet: WorkerDispatchPacket, worker: WorkerRegistration): string {
    const note = packet.context_slice.environment_notes.find((item) => item.startsWith("workspace_root="));
    return note ? note.slice("workspace_root=".length) : worker.config.workspace_root;
  }

  private buildPrompt(packet: WorkerDispatchPacket, worker: WorkerRegistration): string {
    const isRecon = packet.subgoal_contract.kind === "recon";
    const baseLines = [
      `Demand: ${packet.clarified_demand}`,
      `Subgoal: ${packet.subgoal_contract.title}${isRecon ? "  [RECON]" : ""}`,
      `Subgoal objective: ${packet.subgoal_contract.objective}`,
      `Success criteria: ${packet.subgoal_contract.success_criteria.join("; ")}`,
      `Constraints: ${packet.subgoal_contract.constraints.join("; ")}`,
      `Workspace root: ${this.readWorkspaceRoot(packet, worker)}`
    ];

    if (isRecon) {
      return [
        ...baseLines,
        "This is a RECONNAISSANCE subgoal: read-only inspection of the target environment.",
        "Do NOT create, edit, delete, move or rename any file. Do NOT run mutating commands.",
        "Only use read-only operations (cat / ls / find / grep / git status / git log / etc).",
        "Output a concise text summary of what you found at the end. Do not write that summary to a file; print it to stdout.",
        "When finished, exit the process."
      ].join("\n");
    }

    return [
      ...baseLines,
      "Execute the coding task directly in the workspace root.",
      "Create or modify the necessary files only for this subgoal.",
      "When finished, exit the process so the scheduler can collect the result."
    ].join("\n");
  }

  protected resolveCommand(worker: WorkerRegistration, packet: WorkerDispatchPacket) {
    const workspaceRoot = this.readWorkspaceRoot(packet, worker);
    const binaryPath = path.join(OPEN_CODE_INSTALL_ROOT, "bin", "opencode");
    return {
      command: binaryPath,
      args: [
        "run",
        "--format",
        "json",
        "--title",
        packet.subgoal_contract.title,
        this.buildPrompt(packet, worker)
      ],
      env: {
        HOME: OPEN_CODE_RUNTIME_HOME,
        PATH: `${path.join(OPEN_CODE_INSTALL_ROOT, "bin")}:${process.env.PATH ?? ""}`,
        NODIKT_EXECUTION_ID: packet.execution_id,
        CI: "1",
        ...(worker.config.env ?? {})
      },
      cwd: workspaceRoot
    };
  }
}
