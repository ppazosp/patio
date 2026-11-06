// Wire format shared by the relay, the daemon and every client.
// Live-only: the relay delivers to whoever is online and stores nothing.

export const PROTOCOL_VERSION = 1;

export type Kind = "question" | "report" | "heads-up" | "request" | "reply";
export const KINDS: Kind[] = ["question", "report", "heads-up", "request", "reply"];

export type Context = {
  repo?: string;
  pr?: string;
  files?: string[];
};

export type Message = {
  id: string;
  // Every message belongs to a conversation; a reply carries the conversation of the message it answers.
  convo: string;
  // Stamped by the relay from the authenticated connection, never trusted from the sender.
  from: string;
  to: string;
  kind: Kind;
  text: string;
  context?: Context;
  ts: number;
};

// What a sender submits; the relay fills in `from` and `ts`.
export type Outgoing = Omit<Message, "from" | "ts">;

export type ClientFrame =
  | { type: "hello"; v: number; handle: string; token?: string }
  | { type: "send"; msg: Outgoing }
  | { type: "who" };

export type RelayFrame =
  | { type: "welcome"; handle: string }
  | { type: "error"; message: string }
  | { type: "sent"; id: string }
  | { type: "undeliverable"; id: string; reason: "offline" | "invalid"; detail?: string }
  | { type: "deliver"; msg: Message }
  | { type: "presence"; online: string[] };

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function newId(): string {
  return crypto.randomUUID();
}

export function validateOutgoing(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return "message must be an object";
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "string" || !m.id) return "id is required";
  if (typeof m.convo !== "string" || !m.convo) return "convo is required";
  if (typeof m.to !== "string" || !HANDLE_RE.test(m.to)) return "to must be a valid handle";
  if (!KINDS.includes(m.kind as Kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (typeof m.text !== "string" || !m.text.trim()) return "text is required";
  if (m.text.length > 32_000) return "text is over 32000 characters";
  return null;
}
