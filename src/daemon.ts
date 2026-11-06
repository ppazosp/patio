// The daemon: keeps this person online at the relay, serves the local socket that the CLI
// and MCP server use, and applies this person's rules to every incoming message.
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { buildPrompt, runAgent, sessionMeta } from "./acp";
import type { Config } from "./config";
import {
  KINDS,
  newId,
  PROTOCOL_VERSION,
  type ClientFrame,
  type Kind,
  type Message,
  type Outgoing,
  type RelayFrame,
} from "./protocol";
import { agentCommand, agentCwd, loadRules, pickRule, type Rule, type Rules } from "./rules";

type SendResult = { ok: true } | { ok: false; reason: string; detail?: string };

const RECENT_LIMIT = 100;
const REPLY_TTL_MS = 60 * 60_000;

export async function startDaemon(cfg: Config, opts: { log?: (line: string) => void } = {}) {
  if (!cfg.handle) throw new Error("set PATIO_HANDLE to your handle");
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`));
  const rules: Rules = await loadRules(cfg.home);

  // ---- relay connection -------------------------------------------------
  let ws: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  const pendingSends = new Map<string, (r: SendResult) => void>();
  const pendingWho: Array<(online: string[]) => void> = [];

  const sendFrame = (frame: ClientFrame) => ws?.send(JSON.stringify(frame));

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(cfg.relay);
    ws.onopen = () => sendFrame({ type: "hello", v: PROTOCOL_VERSION, handle: cfg.handle, token: cfg.token });
    ws.onmessage = (ev) => {
      try {
        onRelayFrame(JSON.parse(String(ev.data)) as RelayFrame);
      } catch (err) {
        log(`ignored a bad frame from the relay: ${(err as Error).message}`);
      }
    };
    ws.onclose = () => {
      if (connected) log("disconnected from relay");
      connected = false;
      for (const [, resolve] of pendingSends) resolve({ ok: false, reason: "relay_down" });
      pendingSends.clear();
      for (const resolve of pendingWho.splice(0)) resolve([]);
      if (!stopped) setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
  };

  const onRelayFrame = (frame: RelayFrame) => {
    switch (frame.type) {
      case "welcome":
        connected = true;
        log(`online as ${frame.handle} at ${cfg.relay}`);
        return;
      case "error":
        log(`relay error: ${frame.message}`);
        return;
      case "sent":
        pendingSends.get(frame.id)?.({ ok: true });
        pendingSends.delete(frame.id);
        return;
      case "undeliverable":
        pendingSends.get(frame.id)?.({ ok: false, reason: frame.reason, detail: frame.detail });
        pendingSends.delete(frame.id);
        return;
      case "presence":
        pendingWho.shift()?.(frame.online);
        return;
      case "deliver":
        onMessage(frame.msg);
        return;
    }
  };

  const relaySend = (msg: Outgoing): Promise<SendResult> => {
    if (!connected) return Promise.resolve({ ok: false, reason: "relay_down" });
    return new Promise((resolve) => {
      pendingSends.set(msg.id, resolve);
      sendFrame({ type: "send", msg });
    });
  };

  const relayWho = (): Promise<string[]> => {
    if (!connected) return Promise.resolve([]);
    return new Promise((resolve) => {
      pendingWho.push(resolve);
      sendFrame({ type: "who" });
    });
  };

  // ---- local state: only in memory, only on this machine -----------------
  const recent: Message[] = []; // incoming messages that are not replies
  const replies = new Map<string, { queue: Message[]; at: number }>();
  const waiters = new Map<string, Set<(m: Message) => void>>();
  const watchers = new Set<ReadableStreamDefaultController<string>>();
  let agentRunsToday = { day: today(), count: 0 };

  const onMessage = (msg: Message) => {
    for (const w of watchers) w.enqueue(JSON.stringify(msg) + "\n");
    if (msg.kind === "reply") {
      const waiting = waiters.get(msg.convo);
      const first = waiting?.values().next().value;
      if (first) {
        waiting!.delete(first);
        first(msg);
      } else {
        const entry = replies.get(msg.convo) ?? { queue: [], at: Date.now() };
        entry.queue.push(msg);
        replies.set(msg.convo, entry);
      }
      log(`reply from ${msg.from} on ${msg.convo.slice(0, 8)}`);
      return;
    }
    recent.push(msg);
    if (recent.length > RECENT_LIMIT) recent.shift();
    void handleIncoming(msg).catch((err) => log(`handler failed for ${msg.id.slice(0, 8)}: ${err.message}`));
  };

  // ---- the person's rules -----------------------------------------------
  const reply = async (to: Message, text: string) => {
    const res = await relaySend({ id: newId(), convo: to.convo, to: to.from, kind: "reply", text });
    if (!res.ok) log(`could not reply to ${to.from}: ${res.reason}`);
  };

  const handleIncoming = async (msg: Message) => {
    const rule: Rule = pickRule(rules, msg);
    log(`${msg.kind} from ${msg.from} on ${msg.convo.slice(0, 8)} -> ${rule.do}: ${oneLine(msg.text)}`);
    switch (rule.do) {
      case "refuse":
        return reply(msg, `${cfg.handle}'s rules do not accept this kind of message from you.`);
      case "notify":
        notify(`${msg.from} (${msg.kind})`, msg.text);
        return;
      case "run": {
        const proc = Bun.spawn(rule.command!, { stdin: new Blob([JSON.stringify(msg)]), stdout: "pipe", stderr: "inherit" });
        const out = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        if (out) await reply(msg, out);
        return;
      }
      case "agent": {
        if (agentRunsToday.day !== today()) agentRunsToday = { day: today(), count: 0 };
        if (agentRunsToday.count >= rules.limits.agent_runs_per_day) {
          notify(`${msg.from} (${msg.kind})`, msg.text);
          return reply(msg, `${cfg.handle}'s agent has reached today's limit; ${cfg.handle} has been notified instead.`);
        }
        agentRunsToday.count++;
        const started = Date.now();
        try {
          const permissions = rule.permissions ?? "read-only";
          const run = await runAgent({
            command: agentCommand(rule),
            meta: sessionMeta(rule.agent!, permissions),
            cwd: agentCwd(rule),
            prompt: buildPrompt(msg, cfg.handle),
            permissions,
            log: (line) => log(`  [agent] ${line}`),
          });
          log(`agent finished in ${Math.round((Date.now() - started) / 1000)}s (${run.stopReason})`);
          return reply(msg, run.reply || `${cfg.handle}'s agent finished without an answer.`);
        } catch (err) {
          log(`agent failed: ${(err as Error).message}`);
          notify(`${msg.from} (${msg.kind})`, msg.text);
          return reply(msg, `${cfg.handle}'s agent could not answer; ${cfg.handle} has been notified.`);
        }
      }
    }
  };

  // ---- local socket for the CLI and the MCP server ------------------------
  await mkdir(cfg.home, { recursive: true, mode: 0o700 });
  await mkdir(dirname(cfg.socket), { recursive: true, mode: 0o700 });
  await assertPrivateDir(dirname(cfg.socket));
  const running = await fetch("http://daemon/status", { unix: cfg.socket } as RequestInit).catch(() => null);
  if (running?.ok) throw new Error(`a daemon is already running on ${cfg.socket}`);
  await rm(cfg.socket, { force: true });

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fail = (status: number, code: string, error: string) => json({ code, error }, status);

  const sendFromLocal = async (to: string, kind: Kind, text: string, context: Message["context"], convo?: string) => {
    const msg: Outgoing = { id: newId(), convo: convo ?? newId(), to, kind, text, context };
    const res = await relaySend(msg);
    if (res.ok) return json({ id: msg.id, convo: msg.convo });
    if (res.reason === "offline") return fail(409, "offline", `${to} is offline; live messages only reach people who are online`);
    if (res.reason === "relay_down") return fail(503, "relay_down", "not connected to the relay");
    return fail(400, res.reason, res.detail ?? "message rejected");
  };

  // The socket is created owner-only from the start, not just chmod-ed afterwards.
  const previousUmask = process.umask(0o077);
  const local = Bun.serve({
    unix: cfg.socket,
    // Long-polls and the watch stream stay open with no traffic. Bun honours this on unix sockets,
    // but its types only allow it for TCP.
    ...({ idleTimeout: 0 } as {}),
    routes: {
      "/status": () => json({ handle: cfg.handle, connected, relay: cfg.relay }),
      "/who": async () => json({ online: await relayWho() }),
      "/list": () => json({ messages: recent }),
      "/send": {
        POST: async (req) => {
          const b = (await req.json()) as { to: string; kind?: Kind; text: string; context?: Message["context"]; convo?: string };
          const kind = b.kind ?? "question";
          if (!KINDS.includes(kind) || kind === "reply") return fail(400, "invalid", "use /reply to answer a message");
          return sendFromLocal(b.to, kind, b.text, b.context, b.convo);
        },
      },
      "/reply": {
        POST: async (req) => {
          const b = (await req.json()) as { convo: string; text: string };
          const original = [...recent].reverse().find((m) => m.convo === b.convo);
          if (!original) return fail(404, "unknown_convo", "no incoming message with that conversation id");
          return sendFromLocal(original.from, "reply", b.text, undefined, b.convo);
        },
      },
      "/wait": async (req) => {
        const url = new URL(req.url);
        const convo = url.searchParams.get("convo") ?? "";
        const seconds = Math.min(Number(url.searchParams.get("timeout") ?? 50), 55);
        const queued = replies.get(convo);
        if (queued?.queue.length) {
          const next = queued.queue.shift()!;
          if (!queued.queue.length) replies.delete(convo);
          return json({ reply: next });
        }
        const reply = await new Promise<Message | null>((resolve) => {
          let set = waiters.get(convo);
          if (!set) waiters.set(convo, (set = new Set()));
          const waiter = (m: Message) => {
            clearTimeout(timer);
            resolve(m);
          };
          const timer = setTimeout(() => {
            set!.delete(waiter);
            if (!set!.size) waiters.delete(convo);
            resolve(null);
          }, seconds * 1000);
          set.add(waiter);
          req.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            set!.delete(waiter);
            resolve(null);
          });
        });
        return json({ reply });
      },
      "/watch": (req) => {
        let ctrl: ReadableStreamDefaultController<string>;
        const body = new ReadableStream<string>({
          start: (c) => void watchers.add((ctrl = c)),
          cancel: () => void watchers.delete(ctrl),
        });
        req.signal.addEventListener("abort", () => watchers.delete(ctrl));
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      },
    },
    fetch: () => fail(404, "not_found", "unknown endpoint"),
  });
  process.umask(previousUmask);
  await chmod(cfg.socket, 0o600);

  // Drop replies nobody collected within the hour.
  const sweep = setInterval(() => {
    for (const [convo, entry] of replies) if (Date.now() - entry.at > REPLY_TTL_MS) replies.delete(convo);
  }, 60_000);

  connect();
  log(`local socket ${cfg.socket}; rules: default ${rules.default}, ${rules.rules.length} rule(s)`);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(sweep);
      ws?.close();
      local.stop(true);
      await rm(cfg.socket, { force: true });
    },
    isConnected: () => connected,
  };
}

// Someone else could have created the socket's directory first, or swapped it for a symlink.
async function assertPrivateDir(dir: string) {
  const st = await lstat(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} is readable or writable by other users; run chmod 700 on it`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function oneLine(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

function notify(title: string, body: string) {
  if (process.platform !== "darwin" || process.env.PATIO_NO_NOTIFY) return;
  const script = `display notification ${JSON.stringify(oneLine(body))} with title ${JSON.stringify("patio: " + title)}`;
  Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
}
