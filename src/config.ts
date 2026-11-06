import { homedir, tmpdir } from "node:os";
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
  const home = expandHome(env.PATIO_HOME ?? "~/.patio");
  return {
    home,
    handle: env.PATIO_HANDLE ?? "",
    token: env.PATIO_TOKEN,
    relay: env.PATIO_RELAY ?? "ws://127.0.0.1:7777",
    socket: socketPath(home, env),
  };
}

// Unix socket paths are capped at about 104 bytes on macOS, so a long home falls back to a per-user
// runtime directory (macOS's tmpdir is already per user). The daemon checks who owns that directory.
export function socketPath(home: string, env = process.env): string {
  const inHome = join(home, "daemon.sock");
  if (Buffer.byteLength(inHome) < 100) return inHome;
  const hash = new Bun.CryptoHasher("sha256").update(home).digest("hex").slice(0, 16);
  const runtime = env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtime, `patio-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}
