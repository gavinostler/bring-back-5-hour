#!/usr/bin/env node
// Self-imposed 5-hour usage limit for Claude Code.
// Usage is estimated from local transcripts at API prices; windows work like
// Anthropic's old ones: a window opens on your first message and lasts 5 hours.
//
//   node five-hour.mjs status            show current window
//   node five-hour.mjs budget <usd>      set budget per window
//   node five-hour.mjs off [hours]       bypass (default: rest of window)
//   node five-hour.mjs on                end bypass
//   node five-hour.mjs history           recent windows (to pick a budget)
//   node five-hour.mjs hook              UserPromptSubmit hook (reads stdin)
//   node five-hour.mjs statusline        status line text
//   node five-hour.mjs mcp               MCP stdio server

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "config.json");
const WINDOW_MS = 5 * 3600_000;
const LOOKBACK_MS = 48 * 3600_000;
const BYPASS_WORD = "!bypass";

// ---------- config ----------
const DEFAULT_CONFIG = { budgetUsd: 150, bypassUntil: 0, extraDirs: [] };

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------- pricing ($ per MTok: input, output, cache read) ----------
// Cache writes: 1.25x input (5m), 2x input (1h). Fast mode: 2x.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1.0],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-4-[01]|opus-4-2025|claude-3-opus/, 15, 75, 1.5],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku-4/, 1, 5, 0.1],
  [/haiku/, 0.8, 4, 0.08],
];

function priceFor(model) {
  for (const [re, i, o, cr] of PRICES) if (re.test(model)) return { i, o, cr };
  return { i: 4, o: 20, cr: 0.2 };
}

function costOf(model, u) {
  const p = priceFor(model);
  const cc = u.cache_creation || {};
  let write5m = cc.ephemeral_5m_input_tokens ?? 0;
  let write1h = cc.ephemeral_1h_input_tokens ?? 0;
  if (!write5m && !write1h) write5m = u.cache_creation_input_tokens || 0;
  const usd =
    ((u.input_tokens || 0) * p.i +
      write5m * p.i * 1.25 +
      write1h * p.i * 2 +
      (u.cache_read_input_tokens || 0) * p.cr +
      (u.output_tokens || 0) * p.o) /
    1e6;
  return u.speed === "fast" ? usd * 2 : usd;
}

// ---------- transcript scan ----------
function projectDirs(cfg) {
  const home = os.homedir();
  const dirs = new Set([
    path.join(home, ".claude", "projects"),
    path.join(home, ".claude_personal", "projects"),
    path.join(home, ".config", "claude", "projects"),
  ]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(path.join(process.env.CLAUDE_CONFIG_DIR, "projects"));
  for (const d of cfg.extraDirs || []) dirs.add(d);
  return [...dirs].filter((d) => fs.existsSync(d));
}

function* walkJsonl(dir, minMtime) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p, minMtime);
    else if (e.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(p).mtimeMs >= minMtime) yield p;
      } catch {}
    }
  }
}

// Per-file cache: only bytes appended since the last scan get parsed.
const CACHE_PATH = path.join(HERE, ".cache.json");
const CACHE_VERSION = 1;

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (c.v === CACHE_VERSION) return c;
  } catch {}
  return { v: CACHE_VERSION, files: {} };
}

function parseChunk(text, since, out) {
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg || !msg.usage || !rec.timestamp) continue;
    const model = msg.model || "";
    if (!model || model === "<synthetic>") continue;
    const t = Date.parse(rec.timestamp);
    if (!(t >= since)) continue;
    // [dedupe key, time, cost] — streaming repeats usage once per content block.
    out.push([`${msg.id || rec.uuid}:${rec.requestId || ""}`, t, costOf(model, msg.usage)]);
  }
}

function scanFile(file, entry, since) {
  const st = fs.statSync(file);
  if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return entry;
  const fresh = !entry || st.size < entry.size;
  const start = fresh ? 0 : entry.offset;
  const events = fresh ? [] : entry.events.filter((e) => e[1] >= since);
  const fd = fs.openSync(file, "r");
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    // Only consume through the last complete line.
    const lastNl = buf.lastIndexOf(0x0a);
    const consumed = lastNl + 1;
    parseChunk(buf.subarray(0, consumed).toString("utf8"), since, events);
    return { size: st.size, mtimeMs: st.mtimeMs, offset: start + consumed, events };
  } finally {
    fs.closeSync(fd);
  }
}

function collectEvents(cfg, now = Date.now()) {
  const since = now - LOOKBACK_MS;
  const cache = loadCache();
  const nextFiles = {};
  const byKey = new Map();
  for (const dir of projectDirs(cfg)) {
    for (const file of walkJsonl(dir, since)) {
      let entry;
      try {
        entry = scanFile(file, cache.files[file], since);
      } catch {
        continue;
      }
      nextFiles[file] = entry;
      for (const [key, t, cost] of entry.events) {
        if (t < since) continue;
        const prev = byKey.get(key);
        if (!prev || cost > prev.cost) byKey.set(key, { t: prev ? Math.min(prev.t, t) : t, cost });
      }
    }
  }
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ v: CACHE_VERSION, files: nextFiles }));
  } catch {}
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

function buildWindows(events) {
  const windows = [];
  let cur = null;
  for (const ev of events) {
    if (!cur || ev.t >= cur.end) {
      const start = Math.floor(ev.t / 3600_000) * 3600_000;
      cur = { start, end: start + WINDOW_MS, cost: 0, messages: 0 };
      windows.push(cur);
    }
    cur.cost += ev.cost;
    cur.messages++;
  }
  return windows;
}

function getStatus(now = Date.now()) {
  const cfg = loadConfig();
  const windows = buildWindows(collectEvents(cfg, now));
  const last = windows[windows.length - 1];
  const active = last && now < last.end ? last : null;
  const used = active ? active.cost : 0;
  const budget = cfg.budgetUsd;
  const bypassed = cfg.bypassUntil > now;
  return {
    used,
    budget,
    pct: budget > 0 ? (used / budget) * 100 : 0,
    over: used >= budget,
    resetsAt: active ? active.end : null,
    bypassed,
    bypassUntil: bypassed ? cfg.bypassUntil : null,
    windows,
  };
}

// ---------- calibration from real limit hits ----------
// Finds every time Anthropic's own 5-hour limit rejected a request, and totals
// the spend in that window up to the hit. That spend is your plan's real cap.
function findLimitHits(cfg) {
  const hits = new Map(); // resetsAt -> earliest hit time
  const events = [];
  const seen = new Set();
  for (const dir of projectDirs(cfg)) {
    for (const file of walkJsonl(dir, 0)) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const ev = [];
      parseChunk(text, 0, ev);
      for (const e of ev) if (!seen.has(e[0])) (seen.add(e[0]), events.push(e));
      if (!text.includes('"five_hour"')) continue;
      for (const line of text.split("\n")) {
        if (!line.includes('"five_hour"')) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const info = rec.apiErrorParams?.rate_limit_info || rec.quotaLimits;
        if (!info || info.rateLimitType !== "five_hour" || info.status !== "rejected") continue;
        const t = Date.parse(rec.timestamp);
        const reset = info.resetsAt * 1000;
        if (!(t > 0 && reset > 0)) continue;
        hits.set(reset, Math.min(hits.get(reset) ?? Infinity, t));
      }
    }
  }
  return [...hits].sort((a, b) => a[0] - b[0]).map(([reset, hitAt]) => {
    const start = reset - WINDOW_MS;
    const spend = events.reduce((sum, [, t, c]) => (t >= start && t <= hitAt ? sum + c : sum), 0);
    return { start, hitAt, reset, spend };
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- formatting ----------
const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const usd = (n) => `$${n.toFixed(2)}`;

function statusText(s) {
  const parts = [`5h ${Math.round(s.pct)}%`, `${usd(s.used)}/${usd(s.budget)}`];
  if (s.resetsAt) parts.push(`resets ${fmtTime(s.resetsAt)}`);
  if (s.bypassed) parts.push("bypassed");
  return parts.join(" · ");
}

// ---------- bypass ----------
function setBypass(hours) {
  const cfg = loadConfig();
  const now = Date.now();
  let until;
  if (hours != null && !Number.isNaN(Number(hours))) until = now + Number(hours) * 3600_000;
  else {
    const s = getStatus(now);
    until = s.resetsAt || now + WINDOW_MS;
  }
  cfg.bypassUntil = until;
  saveConfig(cfg);
  return until;
}
function clearBypass() {
  const cfg = loadConfig();
  cfg.bypassUntil = 0;
  saveConfig(cfg);
}
function setBudget(v) {
  const n = Number(v);
  if (!(n > 0)) throw new Error("Budget must be a positive number of USD");
  const cfg = loadConfig();
  cfg.budgetUsd = n;
  saveConfig(cfg);
  return n;
}

// ---------- hook ----------
async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function runHook() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {}
  if (process.env.FIVE_HOUR_BYPASS === "1") return;

  const prompt = String(input.prompt || "").trim();
  if (prompt.toLowerCase().startsWith(BYPASS_WORD)) {
    setBypass();
    return;
  }

  const s = getStatus();
  if (s.bypassed || !s.over) return;

  const reason = [
    `5-hour limit reached (${usd(s.used)}/${usd(s.budget)})`,
    s.resetsAt ? `resets ${fmtTime(s.resetsAt)}` : null,
    `start a message with ${BYPASS_WORD} to continue`,
  ]
    .filter(Boolean)
    .join(" · ");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

// ---------- MCP server (stdio, JSON-RPC, no deps) ----------
const TOOLS = [
  {
    name: "usage",
    description: "Current 5-hour window usage, budget, and reset time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bypass",
    description: "Lift the 5-hour limit. Omit hours for the rest of the current window. Only call when the user asks.",
    inputSchema: {
      type: "object",
      properties: { hours: { type: "number", description: "Hours to bypass" } },
      additionalProperties: false,
    },
  },
  {
    name: "end_bypass",
    description: "Re-enable the 5-hour limit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_budget",
    description: "Set the USD budget per 5-hour window. Only call when the user asks.",
    inputSchema: {
      type: "object",
      properties: { usd: { type: "number" } },
      required: ["usd"],
      additionalProperties: false,
    },
  },
];

function callTool(name, args = {}) {
  switch (name) {
    case "usage": {
      const s = getStatus();
      return statusText(s) + (s.over && !s.bypassed ? " · limit reached" : "");
    }
    case "bypass":
      return `Bypassed until ${fmtDateTime(setBypass(args.hours))}`;
    case "end_bypass":
      clearBypass();
      return "Limit re-enabled";
    case "set_budget":
      return `Budget set to ${usd(setBudget(args.usd))} per 5 hours`;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function runMcp() {
  let buf = "";
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (req.id === undefined) continue; // notification
      const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });
      const fail = (code, message) => send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
      switch (req.method) {
        case "initialize":
          reply({
            protocolVersion: req.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "five-hour", version: "1.0.0" },
          });
          break;
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call":
          try {
            const text = callTool(req.params?.name, req.params?.arguments);
            reply({ content: [{ type: "text", text }] });
          } catch (e) {
            reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
          }
          break;
        default:
          fail(-32601, `Method not found: ${req.method}`);
      }
    }
  });
}

// ---------- CLI ----------
const [cmd = "status", arg] = process.argv.slice(2);
switch (cmd) {
  case "hook":
    await runHook().catch(() => {}); // never break prompting on a script error
    break;
  case "statusline":
    await readStdin().catch(() => {});
    process.stdout.write(statusText(getStatus()));
    break;
  case "status": {
    const s = getStatus();
    console.log(statusText(s) + (s.over && !s.bypassed ? " · limit reached" : ""));
    break;
  }
  case "history": {
    const s = getStatus();
    for (const w of s.windows)
      console.log(`${fmtDateTime(w.start).padEnd(16)} ${usd(w.cost).padStart(9)}  ${w.messages} msgs`);
    if (!s.windows.length) console.log("No usage in the last 48h");
    break;
  }
  case "calibrate": {
    const hits = findLimitHits(loadConfig()).filter((h) => h.spend > 0);
    if (!hits.length) {
      console.log("No past 5-hour limit hits found");
      break;
    }
    const fmtDay = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const h of hits) console.log(`${fmtDay(h.hitAt).padEnd(18)} ${usd(h.spend).padStart(9)}`);
    // Latest hit reflects the current plan and current model prices.
    const latest = hits[hits.length - 1].spend;
    if (arg === "--apply") console.log(`Budget: ${usd(setBudget(Math.round(latest)))} per 5 hours`);
    else console.log(`Latest: ${usd(latest)} · median: ${usd(median(hits.map((h) => h.spend)))} · "calibrate --apply" uses latest`);
    break;
  }
  case "budget":
    if (arg == null) console.log(usd(loadConfig().budgetUsd));
    else console.log(`Budget: ${usd(setBudget(arg))} per 5 hours`);
    break;
  case "off":
    console.log(`Bypassed until ${fmtDateTime(setBypass(arg))}`);
    break;
  case "on":
    clearBypass();
    console.log("Limit re-enabled");
    break;
  case "mcp":
    runMcp();
    break;
  default:
    console.log("Commands: status | history | calibrate [--apply] | budget [usd] | off [hours] | on | hook | statusline | mcp");
    process.exitCode = 1;
}
