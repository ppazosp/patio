// Client for the daemon's local socket, used by the CLI commands and the MCP server.
import type { Config } from "./config";
import type { Context, Kind, Message } from "./protocol";

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function call<T>(cfg: Config, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://daemon${path}`, { ...init, unix: cfg.socket } as RequestInit);
  } catch {
    throw new DaemonError(`no daemon at ${cfg.socket}; start it with \`inbox up\``, "no_daemon");
  }
  const body = (await res.json()) as T & { error?: string; code?: string };
  if (!res.ok) throw new DaemonError(body.error ?? `daemon returned ${res.status}`, body.code ?? "error");
  return body;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type SendInput = { to: string; kind: Kind; text: string; context?: Context; convo?: string };

export const daemon = {
  status: (cfg: Config) => call<{ handle: string; connected: boolean; relay: string }>(cfg, "/status"),
  who: (cfg: Config) => call<{ online: string[] }>(cfg, "/who"),
  send: (cfg: Config, input: SendInput) => call<{ id: string; convo: string }>(cfg, "/send", post(input)),
  reply: (cfg: Config, convo: string, text: string) =>
    call<{ id: string; convo: string }>(cfg, "/reply", post({ convo, text })),
  list: (cfg: Config) => call<{ messages: Message[] }>(cfg, "/list"),
  // One long-poll round; returns null when nothing arrived within `seconds`.
  waitOnce: async (cfg: Config, convo: string, seconds: number) => {
    const res = await call<{ reply: Message | null }>(
      cfg,
      `/wait?convo=${encodeURIComponent(convo)}&timeout=${seconds}`,
    );
    return res.reply;
  },
};

// Waits up to `totalSeconds`, polling in short rounds so no single HTTP request stays open too long.
export async function waitForReply(cfg: Config, convo: string, totalSeconds: number): Promise<Message | null> {
  const deadline = Date.now() + totalSeconds * 1000;
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) return null;
    const reply = await daemon.waitOnce(cfg, convo, Math.min(left, 50));
    if (reply) return reply;
  }
}
