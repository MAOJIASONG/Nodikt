/**
 * 文件名称：app.ts
 * 文件作用：后端应用装配入口，负责组装 HTTP 服务、WebSocket 服务、仓储、调度器与各类业务服务。
 *
 * 主要职责：
 * 1. 创建 Express 应用和原生 HTTP Server。
 * 2. 初始化事件总线、任务处理器、模型客户端、工作器适配器与实时广播服务。
 * 3. 挂载 API 路由、静态前端资源和统一异常处理。
 * 4. 暴露完整应用上下文，供启动入口和测试环境复用。
 *
 * 依赖模块：
 * - interface/http/routes：HTTP API 路由工厂。
 * - brain/*：规划、决策、调度、仓储、审查与运维服务。
 * - worker/adapters：本地工作器适配器与注册表。
 *
 * 注意事项：
 * - 本文件只负责依赖装配和服务边界连接，不应承载具体业务规则。
 * - 新增全局服务时，应在这里完成实例化并注入到事件总线上下文。
 */
import http from "http";
import fs from "fs";
import path from "path";

import cors from "cors";
import express from "express";
import { WebSocketServer } from "ws";

import type { Session } from "./domain/index.js";
import { createApiRouter } from "./interface/http/routes.js";
import { DecisionService } from "./brain/engines/decision/service.js";
import { DispatcherService } from "./brain/dispatch/dispatcher/service.js";
import { EventBus } from "./brain/scheduler/event_bus/index.js";
import { createHandlers } from "./brain/scheduler/handlers/index.js";
import { LlmClient } from "./brain/engines/llm/index.js";
import { MemoryManager } from "./brain/store/memory_manager/service.js";
import { OpsMonitor } from "./brain/ops/service.js";
import { PlannerService } from "./brain/engines/planner/service.js";
import { ReconciliationService } from "./brain/review/reconciliation/service.js";
import { RepositoryBundle } from "./brain/store/repositories/index.js";
import { VerifierService } from "./brain/review/verifier/service.js";
import { ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter } from "./worker/adapters/index.js";
import { AdapterRegistry } from "./worker/adapters/registry.js";
import { WsBroadcaster } from "./interface/realtime/service.js";
import { deriveSessionFromDemand, stripRuntimeSessionMetadata } from "./brain/scheduler/handlers/sessionState.js";
import { reduceSession } from "./brain/scheduler/session/sessionReducer.js";

async function ensureSessionStore(repositories: RepositoryBundle): Promise<void> {
  const [demands, sessions, events] = await Promise.all([
    repositories.demands.list(),
    repositories.sessions.list(),
    repositories.events.list()
  ]);
  const sessionsByDemandId = new Map(sessions.map((session) => [session.demand_id, session]));
  const eventsByDemandId = new Map<string, typeof events>();
  for (const event of events) {
    if (!event.demand_id) {
      continue;
    }
    eventsByDemandId.set(event.demand_id, [...(eventsByDemandId.get(event.demand_id) ?? []), event]);
  }
  const nextSessions = demands.map((demand) => {
    const demandEvents = (eventsByDemandId.get(demand.demand_id) ?? [])
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    if (demandEvents.length === 0) {
      return deriveSessionFromDemand(demand, sessionsByDemandId.get(demand.demand_id));
    }
    let session: Session | null = sessionsByDemandId.get(demand.demand_id) ?? null;
    for (const event of demandEvents) {
      session = reduceSession(session, demand, event);
    }
    return session ?? deriveSessionFromDemand(demand);
  });

  await repositories.sessions.saveAll(nextSessions);
  await Promise.all(
    demands
      .filter((demand) => demand.metadata?.runtime_session !== undefined)
      .map((demand) => repositories.demands.upsert({
        ...demand,
        metadata: stripRuntimeSessionMetadata(demand.metadata)
      }))
  );
}

/**
 * 函数作用：创建并装配后端应用上下文。
 *
 * 参数说明：
 * - 无。
 *
 * 返回值：
 * - 返回包含 Express 应用、HTTP 服务、WebSocket 服务、仓储、事件总线和工作器适配器的运行时上下文。
 *
 * 注意事项：
 * - 本函数会实例化核心服务并挂载路由，但不会主动监听端口。
 */
export async function createApp() {
  const repositories = new RepositoryBundle(path.resolve(__dirname, "../data"));
  await ensureSessionStore(repositories);
  const dispatcher = new DispatcherService();
  const llmClient = new LlmClient();
  const verifier = new VerifierService(llmClient);
  const reconciliation = new ReconciliationService();
  const planner = new PlannerService(llmClient);
  const decisionService = new DecisionService(llmClient);
  const memoryManager = new MemoryManager();
  const adapterRegistry = new AdapterRegistry();
  // 把 adapter 实例的构造提前到 createApiRouter 之前 —— POST /workers/register 路由要按
  // adapter_type 找到对应 adapter 并 register 给新 worker（这样新 worker 一进系统就能被
  // ops health check 视为 IDLE，绿灯亮）。之前这些实例在 createApp return 时才创建，
  // 路由根本拿不到。
  const codexAdapter = new CodexAdapter();
  const opencodeAdapter = new OpenCodeAdapter();
  const claudeCodeAdapter = new ClaudeCodeAdapter();
  const adapters = { codexAdapter, opencodeAdapter, claudeCodeAdapter };

  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const wsBroadcaster = new WsBroadcaster(wss, repositories);
  const opsMonitor = new OpsMonitor(repositories, adapterRegistry);

  const handlers = createHandlers();
  const eventBus = new EventBus(handlers, repositories, (publish) => ({
    repositories,
    planner,
    dispatcher,
    verifier,
    reconciliation,
    decisionService,
    memoryManager,
    adapterRegistry,
    wsBroadcaster,
    opsMonitor,
    publish
  }));

  const app = express();
  const webDistDir = path.resolve(__dirname, "../../web/dist");
  const hasWebDist = fs.existsSync(path.join(webDistDir, "index.html"));

  app.use(cors());
  app.use(express.json());
  app.use("/api", createApiRouter(repositories, eventBus, adapterRegistry, adapters));

  if (hasWebDist) {
    app.use(express.static(webDistDir));
    app.get("/", (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.status(200).type("text/plain").send("Nodikt server is running. Build the web app or use /api and /ws.");
    });
  }

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });

  server.on("request", app);
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  return {
    app,
    server,
    wss,
    repositories,
    eventBus,
    opsMonitor,
    adapterRegistry,
    adapters
  };
}
