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
  return validateContext(m.context);
}

// Context ends up in the receiving agent's prompt, so keep it to short single-line strings.
const CONTEXT_FIELD_RE = /^[^\r\n]{1,200}$/;

function validateContext(ctx: unknown): string | null {
  if (ctx === undefined || ctx === null) return null;
  if (typeof ctx !== "object" || Array.isArray(ctx)) return "context must be an object";
  const c = ctx as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!["repo", "pr", "files"].includes(key)) return `unknown context field ${key}`;
  for (const key of ["repo", "pr"] as const)
    if (c[key] !== undefined && (typeof c[key] !== "string" || !CONTEXT_FIELD_RE.test(c[key] as string)))
      return `context.${key} must be a single line under 200 characters`;
  if (c.files !== undefined) {
    if (!Array.isArray(c.files) || c.files.length > 50) return "context.files must be a list of at most 50 paths";
    if (c.files.some((f) => typeof f !== "string" || !CONTEXT_FIELD_RE.test(f)))
      return "each context.files entry must be a single line under 200 characters";
  }
  return null;
}
