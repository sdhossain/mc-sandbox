// Dashboard client: renders lab events (live over SSE, or a past run's events.jsonl) as a timeline per agent.
// Every string from the model or the game is inserted with textContent, never as HTML.

const state = {
  /** @type {Map<string, AgentView>} */
  agents: new Map(),
  selected: null,
  /** Name of the past run being viewed, or "" for live. */
  history: "",
};

class AgentView {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.status = null;
    this.run = null;
    this.totals = emptyTotals();
  }
}

function emptyTotals() {
  return { turns: 0, steps: 0, toolCalls: 0, toolErrors: 0, input: 0, cached: 0, output: 0, reasoning: 0, cost: 0 };
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const usd = (value) => `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`;
const seconds = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60000).toFixed(1)} min`);
const position = (p) => (p ? `(${p.x}, ${p.y}, ${p.z})` : "?");

// ---------------------------------------------------------------------------------------------------------------------
// Event intake

function ingest(event) {
  let view = state.agents.get(event.agent);
  if (!view) {
    view = new AgentView(event.agent);
    state.agents.set(event.agent, view);
    renderTabs();
  }
  if (event.type === "run.started") {
    view.events = [];
    view.totals = emptyTotals();
    view.run = event;
  }
  if (event.type === "bot.status") {
    view.status = event.data;
  } else {
    view.events.push(event);
  }
  accumulate(view.totals, event);
  if (state.selected === null) selectAgent(event.agent);
  else if (state.selected === event.agent) renderIncrement(view, event);
}

function accumulate(totals, event) {
  if (event.type === "model.response") {
    const usage = event.data.usage;
    totals.steps += 1;
    totals.input += usage.inputTokens;
    totals.cached += usage.cachedInputTokens;
    totals.output += usage.outputTokens;
    totals.reasoning += usage.reasoningTokens;
    totals.cost += event.data.costUsd;
  } else if (event.type === "tool.finished") {
    totals.toolCalls += 1;
    if (!event.data.ok) totals.toolErrors += 1;
  } else if (event.type === "turn.ended") {
    totals.turns += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering

function renderTabs() {
  const nav = document.getElementById("agent-tabs");
  nav.replaceChildren();
  for (const name of state.agents.keys()) {
    const button = el("button", name === state.selected ? "active" : "", name);
    button.addEventListener("click", () => selectAgent(name));
    nav.append(button);
  }
}

function selectAgent(name) {
  state.selected = name;
  renderTabs();
  const view = state.agents.get(name);
  const timeline = document.getElementById("timeline");
  timeline.replaceChildren();
  currentTurn = null;
  pendingTools.clear();
  for (const event of view.events) renderIncrement(view, event, false);
  renderSidebar(view);
  window.scrollTo(0, document.body.scrollHeight);
}

let currentTurn = null;
const pendingTools = new Map();

function turnContainer(event) {
  if (currentTurn === null) {
    currentTurn = el("article", "turn");
    currentTurn.append(el("h3", "", "Before the first task"));
    document.getElementById("timeline").append(currentTurn);
  }
  return currentTurn;
}

function renderIncrement(view, event, live = true) {
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  switch (event.type) {
    case "turn.started": {
      currentTurn = el("article", "turn");
      currentTurn.append(el("h3", "", `Turn ${event.turn}: ${event.data.from} (${event.data.source})`));
      const owner = el("div", "entry owner");
      owner.append(el("div", "say", event.data.message));
      const delivered = el("details");
      delivered.append(el("summary", "", "as delivered to the model"), el("pre", "", event.data.delivered));
      owner.append(delivered);
      currentTurn.append(owner);
      document.getElementById("timeline").append(currentTurn);
      break;
    }
    case "model.response": {
      const entry = el("div", "entry model");
      const usage = event.data.usage;
      entry.append(
        el(
          "div",
          "meta",
          `step ${event.step} · ${seconds(event.data.latencyMs)} · ${usage.inputTokens} in (${usage.cachedInputTokens} cached) · ${usage.outputTokens} out (${usage.reasoningTokens} reasoning) · ${usd(event.data.costUsd)}`,
        ),
      );
      for (const item of event.data.items) {
        if (item.kind === "reasoning" && item.summary) entry.append(el("div", "reasoning", item.summary));
        if (item.kind === "assistant" && item.text) entry.append(el("div", "say", item.text));
      }
      turnContainer(event).append(entry);
      break;
    }
    case "tool.started": {
      const entry = el("div", "entry tool");
      const head = el("div");
      head.append(el("span", "tool-name", event.data.name), el("span", "muted", " running…"));
      entry.append(head);
      const args = event.data.arguments;
      if (event.data.name === "run_code" && args && typeof args.code === "string") {
        entry.append(el("pre", "", args.code));
      } else {
        entry.append(el("pre", "", JSON.stringify(args)));
      }
      pendingTools.set(event.data.callId, entry);
      turnContainer(event).append(entry);
      break;
    }
    case "tool.progress": {
      const entry = pendingTools.get(event.data.callId);
      if (entry) entry.querySelector(".muted").textContent = ` ${event.data.message}`;
      break;
    }
    case "tool.finished": {
      let entry = pendingTools.get(event.data.callId);
      if (!entry) {
        entry = el("div", "entry tool");
        entry.append(el("div", "tool-name", event.data.name));
        turnContainer(event).append(entry);
      }
      pendingTools.delete(event.data.callId);
      entry.classList.add(event.data.ok ? "ok" : "fail");
      const status = entry.querySelector(".muted");
      if (status) status.textContent = ` ${event.data.ok ? "ok" : "failed"} · ${seconds(event.data.durationMs)}`;
      entry.append(el("pre", event.data.ok ? "" : "fail-text", event.data.output));
      break;
    }
    case "message.delivered": {
      const entry = el("div", "entry owner");
      entry.append(el("div", "say", `${event.data.from} (while working): ${event.data.message}`));
      turnContainer(event).append(entry);
      break;
    }
    case "model.error":
    case "budget.exceeded":
    case "bot.lifecycle":
    case "log": {
      if (event.type === "log" && event.data.level === "debug") break;
      const text =
        event.type === "model.error"
          ? `model error: ${event.data.message}`
          : event.type === "budget.exceeded"
            ? `budget exceeded: ${event.data.budget} (${event.data.value} / ${event.data.limit})`
            : event.type === "bot.lifecycle"
              ? `bot ${event.data.kind}: ${event.data.detail}`
              : `${event.data.level}: ${event.data.message}`;
      turnContainer(event).append(el("div", "entry fail-text", text));
      break;
    }
    case "case.started": {
      currentTurn = el("article", "turn");
      currentTurn.append(el("h3", "", `Case ${event.data.id}: ${event.data.title}`));
      currentTurn.append(
        el(
          "div",
          "entry muted",
          `${event.data.category} · anchored at (${event.data.anchor.x}, ${event.data.anchor.y}, ${event.data.anchor.z})`,
        ),
      );
      document.getElementById("timeline").append(currentTurn);
      break;
    }
    case "case.result": {
      const entry = el("div", `entry end ${event.data.passed ? "ok" : "fail"}`);
      entry.append(
        el(
          "div",
          "",
          `Case ${event.data.caseId} after turn ${event.data.turn}: ${event.data.passed ? "PASS" : "FAIL"}`,
        ),
      );
      for (const check of event.data.checks) {
        entry.append(
          el(
            "div",
            check.passed ? "muted" : "fail-text",
            `${check.passed ? "pass" : "FAIL"} · ${check.label}: ${check.detail}`,
          ),
        );
      }
      turnContainer(event).append(entry);
      break;
    }
    case "checkpoint.saved":
      turnContainer(event).append(el("div", "entry muted", `world checkpoint saved: ${event.data.worldPath}`));
      break;
    case "snapshot.saved":
      turnContainer(event).append(
        el("div", "entry muted", `snapshot (${event.data.phase}): ${event.data.file}, ${event.data.blocks} blocks`),
      );
      break;
    case "turn.ended": {
      const totals = event.data.totals;
      const entry = el("div", "entry end");
      entry.append(
        el(
          "div",
          "",
          `${event.data.status} · ${seconds(event.data.durationMs)} · ${totals.steps} steps · ${totals.toolCalls} tool calls (${totals.toolErrors} failed) · ${usd(totals.costUsd)}`,
        ),
      );
      if (event.data.finalText) entry.append(el("div", "say", event.data.finalText));
      turnContainer(event).append(entry);
      break;
    }
    default:
      break;
  }
  if (live) {
    renderSidebar(view);
    if (atBottom) window.scrollTo(0, document.body.scrollHeight);
  }
}

function renderSidebar(view) {
  const info = document.getElementById("agent-info");
  info.replaceChildren();
  if (view.run) {
    const data = view.run.data;
    addRow(info, "name", view.name);
    addRow(info, "model", data.model);
    addRow(info, "harness", data.harness);
    addRow(info, "privileges", JSON.stringify(data.privileges));
    addRow(info, "run", view.run.runId);
    document.getElementById("instructions").textContent = data.instructions;
    const tools = document.getElementById("tools");
    tools.replaceChildren();
    for (const tool of data.tools) {
      const item = el("li");
      item.append(el("span", "tool-name", tool.name), el("span", "muted", ` ${tool.description}`));
      tools.append(item);
    }
  }
  const bot = document.getElementById("bot-status");
  bot.replaceChildren();
  if (view.status) {
    const s = view.status;
    addRow(bot, "position", `${position(s.position)} facing ${s.facing}`);
    addRow(bot, "health", `${s.health} / 20, food ${s.food} / 20`);
    addRow(bot, "mode", `${s.gameMode}, ${s.dimension}`);
    addRow(bot, "holding", s.heldItem ?? "nothing");
    addRow(bot, "free slots", String(s.freeSlots));
  } else {
    addRow(bot, "status", "no status yet");
  }
  const totals = document.getElementById("totals");
  totals.replaceChildren();
  const t = view.totals;
  addRow(totals, "turns", String(t.turns));
  addRow(totals, "steps", String(t.steps));
  addRow(totals, "tool calls", `${t.toolCalls} (${t.toolErrors} failed)`);
  addRow(totals, "tokens in", `${t.input} (${t.cached} cached)`);
  addRow(totals, "tokens out", `${t.output} (${t.reasoning} reasoning)`);
  addRow(totals, "cost", usd(t.cost));
  document.getElementById("controls").hidden = state.history !== "";
}

function addRow(list, key, value) {
  list.append(el("dt", "", key), el("dd", "", value));
}

// ---------------------------------------------------------------------------------------------------------------------
// Live stream, history, controls

let source = null;

function connectLive() {
  state.agents.clear();
  state.selected = null;
  document.getElementById("timeline").replaceChildren();
  source = new EventSource("/api/events");
  const pill = document.getElementById("connection");
  source.onopen = () => {
    pill.textContent = "live";
    pill.className = "pill live";
  };
  source.onerror = () => {
    pill.textContent = "disconnected";
    pill.className = "pill";
  };
  source.onmessage = (message) => ingest(JSON.parse(message.data));
}

async function loadHistory(runId) {
  source?.close();
  source = null;
  state.agents.clear();
  state.selected = null;
  document.getElementById("timeline").replaceChildren();
  document.getElementById("connection").textContent = "history";
  document.getElementById("connection").className = "pill";
  const text = await (await fetch(`/api/runs/${encodeURIComponent(runId)}/events`)).text();
  for (const line of text.split("\n")) {
    if (line.trim()) ingest(JSON.parse(line));
  }
}

async function loadRunList() {
  const runs = await (await fetch("/api/runs")).json();
  const select = document.getElementById("run-select");
  for (const run of runs) {
    const option = el("option", "", `${run.runId} (${run.status ?? "?"})`);
    option.value = run.runId;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.history = select.value;
    if (select.value === "") connectLive();
    else void loadHistory(select.value);
  });
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

document.getElementById("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const box = document.getElementById("message");
  const text = box.value.trim();
  if (!text || !state.selected) return;
  await post(`/api/agents/${encodeURIComponent(state.selected)}/message`, { text });
  box.value = "";
});

for (const button of document.querySelectorAll("button[data-command]")) {
  button.addEventListener("click", async () => {
    if (!state.selected) return;
    const result = await post(`/api/agents/${encodeURIComponent(state.selected)}/control`, {
      command: button.dataset.command,
    });
    document.getElementById("control-answer").textContent = result.answer ?? result.error ?? "";
  });
}

connectLive();
void loadRunList();
