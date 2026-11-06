// The relay: tracks who is online and passes messages between them. It stores nothing.
import type { ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import {
  HANDLE_RE,
  PROTOCOL_VERSION,
  validateOutgoing,
  type ClientFrame,
  type Message,
  type RelayFrame,
} from "./protocol";

type Conn = { handle?: string };

export type RelayOptions = {
  port?: number;
  hostname?: string;
  // handle -> token. Without it the relay accepts any handle (local development only).
  users?: Map<string, string>;
  log?: (line: string) => void;
};

export function parseUsers(spec: string | undefined): Map<string, string> | undefined {
  if (!spec) return undefined;
  const users = new Map<string, string>();
  for (const pair of spec.split(",")) {
    const [handle, token] = pair.split("=");
    if (!handle || !token) throw new Error(`bad user entry "${pair}", expected handle=token`);
    users.set(handle.trim(), token.trim());
  }
  return users;
}

// An unknown handle never matches, even when the hello carries no token.
export function tokenMatches(expected: string | undefined, given: unknown): boolean {
  if (expected === undefined || typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startRelay(opts: RelayOptions = {}) {
  const log = opts.log ?? ((line: string) => console.log(`[relay] ${line}`));
  // A person can be online from several devices at once.
  const online = new Map<string, Set<ServerWebSocket<Conn>>>();

  const send = (ws: ServerWebSocket<Conn>, frame: RelayFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  const server = Bun.serve<Conn>({
    port: opts.port ?? 7777,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/health") return new Response("ok");
      if (srv.upgrade(req, { data: {} })) return;
      return new Response("agent-inbox relay: connect with a WebSocket", { status: 426 });
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      message(ws, raw) {
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return send(ws, { type: "error", message: "frames must be JSON" });
        }

        if (frame.type === "hello") {
          if (ws.data.handle) return send(ws, { type: "error", message: "already introduced" });
          if (frame.v !== PROTOCOL_VERSION) {
            send(ws, { type: "error", message: `protocol ${frame.v} not supported, relay speaks ${PROTOCOL_VERSION}` });
            return ws.close(4000, "version");
          }
          if (!HANDLE_RE.test(frame.handle)) {
            send(ws, { type: "error", message: "invalid handle" });
            return ws.close(4001, "handle");
          }
          if (opts.users && !tokenMatches(opts.users.get(frame.handle), frame.token)) {
            send(ws, { type: "error", message: "unknown handle or wrong token" });
            return ws.close(4003, "auth");
          }
          ws.data.handle = frame.handle;
          let set = online.get(frame.handle);
          if (!set) online.set(frame.handle, (set = new Set()));
          set.add(ws);
          log(`${frame.handle} online (${set.size} device${set.size === 1 ? "" : "s"})`);
          return send(ws, { type: "welcome", handle: frame.handle });
        }

        const from = ws.data.handle;
        if (!from) return send(ws, { type: "error", message: "say hello first" });

        if (frame.type === "who") {
          return send(ws, { type: "presence", online: [...online.keys()].sort() });
        }

        if (frame.type === "send") {
          const id = typeof frame.msg?.id === "string" ? frame.msg.id : "";
          const problem = validateOutgoing(frame.msg);
          if (problem) return send(ws, { type: "undeliverable", id, reason: "invalid", detail: problem });
          const targets = online.get(frame.msg.to);
          if (!targets?.size) return send(ws, { type: "undeliverable", id, reason: "offline" });
          const msg: Message = {
            id: frame.msg.id,
            convo: frame.msg.convo,
            from,
            to: frame.msg.to,
            kind: frame.msg.kind,
            text: frame.msg.text,
            context: frame.msg.context,
            ts: Date.now(),
          };
          for (const target of targets) send(target, { type: "deliver", msg });
          log(`${from} -> ${msg.to} [${msg.kind}] convo=${msg.convo.slice(0, 8)}`);
          return send(ws, { type: "sent", id });
        }

        send(ws, { type: "error", message: "unknown frame type" });
      },
      close(ws) {
        const handle = ws.data.handle;
        if (!handle) return;
        const set = online.get(handle);
        set?.delete(ws);
        if (set && set.size === 0) online.delete(handle);
        log(`${handle} offline`);
      },
    },
  });

  if (!opts.users) log("no INBOX_USERS set: accepting any handle without a token (development only)");
  log(`listening on ws://${server.hostname}:${server.port}`);
  return server;
}
