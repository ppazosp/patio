import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Config = {
  home: string;
  handle: string;
  token?: string;
  relay: string;
  socket: string;
};

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
}

// Everything comes from the environment so two people can run side by side on one machine.
export function loadConfig(env = process.env): Config {
  const home = expandHome(env.INBOX_HOME ?? "~/.agent-inbox");
  return {
    home,
    handle: env.INBOX_HANDLE ?? "",
    token: env.INBOX_TOKEN,
    relay: env.INBOX_RELAY ?? "ws://127.0.0.1:7777",
    socket: socketPath(home),
  };
}

// Unix socket paths are capped at about 104 bytes on macOS, so a long home falls back to a short per-user directory.
export function socketPath(home: string): string {
  const inHome = join(home, "daemon.sock");
  if (Buffer.byteLength(inHome) < 100) return inHome;
  const hash = new Bun.CryptoHasher("sha256").update(home).digest("hex").slice(0, 16);
  return join("/tmp", `agent-inbox-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}
