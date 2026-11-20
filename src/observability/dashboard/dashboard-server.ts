import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlCommand } from "../../agent/chat-addressing.ts";
import type { Lab } from "../../lab/lab.ts";
import { errorMessage } from "../../utils/errors.ts";
import { MessageSource } from "../../utils/names.ts";
import type { LabEvent } from "../events.ts";
import { RunFiles } from "../run-recorder.ts";

/** Where the dashboard listens. Keep the host on 127.0.0.1: the dashboard can command the agents. */
export interface DashboardOptions {
  readonly host: string;
  readonly port: number;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
/** Recent events kept in memory so a newly opened page shows the session so far. */
const REPLAY_EVENTS = 20_000;
const MAX_BODY_BYTES = 64_000;

/**
 * The live dashboard: a local web page that streams every event of every agent as it happens
 * (Server-Sent Events), shows past runs from the runs directory, and lets the owner send messages,
 * stop or reset an agent.
 */
export class DashboardServer {
  readonly #lab: Lab;
  readonly #options: DashboardOptions;
  readonly #server: Server;
  readonly #clients = new Set<ServerResponse>();
  readonly #recent: LabEvent[] = [];
  readonly #unsubscribe: () => void;

  /**
   * @param lab - The running lab.
   * @param options - Host and port.
   */
  constructor(lab: Lab, options: DashboardOptions) {
    this.#lab = lab;
    this.#options = options;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        sendJson(response, 500, { error: errorMessage(error) });
      });
    });
    this.#unsubscribe = lab.bus.subscribe((event) => {
      this.#broadcast(event);
    });
  }

  /** The page's address. */
  get url(): string {
    return `http://${this.#options.host}:${this.#options.port}/`;
  }

  /** Starts listening. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        resolve();
      });
    });
  }

  /** Stops listening and disconnects every page. */
  close(): Promise<void> {
    this.#unsubscribe();
    for (const client of this.#clients) {
      client.end();
    }
    return new Promise((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      // Idle keep-alive connections would otherwise hold the server open until they time out.
      this.#server.closeAllConnections();
    });
  }

  #broadcast(event: LabEvent): void {
    this.#recent.push(event);
    if (this.#recent.length > REPLAY_EVENTS) {
      this.#recent.splice(0, this.#recent.length - REPLAY_EVENTS);
    }
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) {
      client.write(frame);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const asset = STATIC_FILES[path];
    if (request.method === "GET" && asset !== undefined) {
      response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
      response.end(readFileSync(join(PUBLIC_DIR, asset.file)));
      return;
    }
    if (request.method === "GET" && path === "/api/events") {
      this.#openStream(response);
      return;
    }
    if (request.method === "GET" && path === "/api/agents") {
      sendJson(response, 200, this.#agents());
      return;
    }
    if (request.method === "GET" && path === "/api/runs") {
      sendJson(response, 200, this.#runs());
      return;
    }
    const runEvents = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
    if (request.method === "GET" && runEvents !== null) {
      this.#sendRunEvents(response, decodeURIComponent(runEvents[1] ?? ""));
      return;
    }
    const action = /^\/api\/agents\/([^/]+)\/(message|control)$/.exec(path);
    if (request.method === "POST" && action !== null) {
      await this.#agentAction(request, response, decodeURIComponent(action[1] ?? ""), action[2] ?? "");
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }

  #openStream(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    for (const event of this.#recent) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    this.#clients.add(response);
    response.on("close", () => {
      this.#clients.delete(response);
    });
  }

  #agents(): unknown[] {
    return this.#lab.agents.map((agent) => ({
      name: agent.name,
      model: agent.config.model,
      harness: agent.config.harness,
      privileges: agent.config.privileges,
      runId: agent.runId,
      status: agent.describeStatus(),
    }));
  }

  #runs(): unknown[] {
    const runsDir = this.#lab.config.runsDir;
    if (!existsSync(runsDir)) {
      return [];
    }
    return readdirSync(runsDir)
      .filter((runId) => existsSync(join(runsDir, runId, RunFiles.MANIFEST)))
      .sort()
      .reverse()
      .map((runId) => JSON.parse(readFileSync(join(runsDir, runId, RunFiles.MANIFEST), "utf8")) as unknown);
  }

  #sendRunEvents(response: ServerResponse, runId: string): void {
    if (!/^[\w.-]+$/.test(runId)) {
      sendJson(response, 400, { error: "bad run id" });
      return;
    }
    const path = join(this.#lab.config.runsDir, runId, RunFiles.EVENTS);
    if (!existsSync(path)) {
      sendJson(response, 404, { error: "no such run" });
      return;
    }
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    response.end(readFileSync(path));
  }

  async #agentAction(request: IncomingMessage, response: ServerResponse, name: string, action: string): Promise<void> {
    const agent = this.#lab.agent(name);
    if (agent === undefined) {
      sendJson(response, 404, { error: `no agent named ${name}` });
      return;
    }
    const body = (await readJson(request)) as { text?: unknown; command?: unknown; argument?: unknown };
    const from = this.#lab.config.owners[0] ?? "dashboard";
    if (action === "message" && typeof body.text === "string" && body.text.trim() !== "") {
      agent.submit({ source: MessageSource.DASHBOARD, from, text: body.text.trim(), receivedAtMs: Date.now() });
      sendJson(response, 200, { ok: true });
      return;
    }
    const command = body.command;
    if (
      action === "control" &&
      typeof command === "string" &&
      (Object.values(ControlCommand) as string[]).includes(command)
    ) {
      const argument = typeof body.argument === "string" ? body.argument : "";
      const answer = await agent.control(command as ControlCommand, from, MessageSource.DASHBOARD, argument);
      sendJson(response, 200, { ok: true, answer });
      return;
    }
    sendJson(response, 400, { error: "expected {text} for message or {command, argument?} for control" });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body === "" ? {} : (JSON.parse(body) as unknown));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}
