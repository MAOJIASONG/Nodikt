import http from "http";
import fs from "fs";
import path from "path";

import cors from "cors";
import express from "express";
import { WebSocketServer } from "ws";

import { createApiRouter } from "./api/routes.js";
import { DecisionService } from "./decision/service.js";
import { DispatcherService } from "./dispatcher/service.js";
import { EventBus } from "./event_bus/index.js";
import { createHandlers } from "./handlers/index.js";
import { LlmClient } from "./llm/index.js";
import { MemoryManager } from "./memory_manager/service.js";
import { OpsMonitor } from "./ops_monitor/service.js";
import { PlannerService } from "./planner/service.js";
import { ReconciliationService } from "./reconciliation/service.js";
import { RepositoryBundle } from "./repositories/index.js";
import { VerifierService } from "./verifier/service.js";
import { CodexAdapter, OpenCodeAdapter } from "./worker_adapters/index.js";
import { AdapterRegistry } from "./worker_adapters/registry.js";
import { WsBroadcaster } from "./ws_broadcaster/service.js";

export async function createApp() {
  const repositories = new RepositoryBundle(path.resolve(__dirname, "../data"));
  const dispatcher = new DispatcherService();
  const verifier = new VerifierService();
  const reconciliation = new ReconciliationService();
  const llmClient = new LlmClient();
  const planner = new PlannerService(llmClient);
  const decisionService = new DecisionService(llmClient);
  const memoryManager = new MemoryManager();
  const adapterRegistry = new AdapterRegistry();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const wsBroadcaster = new WsBroadcaster(wss, repositories);
  const opsMonitor = new OpsMonitor(repositories, adapterRegistry);
  const codexAdapter = new CodexAdapter();
  const opencodeAdapter = new OpenCodeAdapter();

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
  app.use("/api", createApiRouter(repositories, eventBus, adapterRegistry, {
    codex: codexAdapter,
    opencode: opencodeAdapter
  }));

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
    adapters: {
      codexAdapter,
      opencodeAdapter
    }
  };
}
