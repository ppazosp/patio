#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig } from "./config";
import { startDaemon } from "./daemon";
import { daemon, DaemonError, waitForReply } from "./local";
import { startMcp } from "./mcp";
import type { Kind } from "./protocol";
import { parseUsers, startRelay } from "./relay";

const USAGE = `inbox: live messages between people's coding agents

  inbox relay [--port 7777] [--host 127.0.0.1]   run the relay (INBOX_USERS="ana=tok,bo=tok2" to require tokens)
  inbox up                                       go online and apply your rules (INBOX_HANDLE, INBOX_RELAY, INBOX_TOKEN)
  inbox who                                      list who is online
  inbox ask <to> <text…> [--kind K] [--repo R] [--pr N] [--file F]… [--wait [secs]]
                                                 send a message; prints the convo id, or the reply with --wait
  inbox wait <convo> [--timeout secs]            block until the reply arrives (exit 0) or time runs out (exit 2)
  inbox reply <convo> <text…>                    answer a message you received
  inbox list                                     recent messages sent to you
  inbox watch                                    stream incoming messages as JSON lines
  inbox mcp                                      run the MCP server over stdio

Exit codes: 0 ok, 1 error, 2 timed out, 3 recipient offline.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (command) {
    case "relay": {
      const { values } = parseArgs({ args: rest, options: { port: { type: "string" }, host: { type: "string" } } });
      startRelay({
        port: Number(values.port ?? process.env.PORT ?? 7777),
        hostname: values.host ?? "127.0.0.1",
        users: parseUsers(process.env.INBOX_USERS),
      });
      return;
    }
    case "up": {
      const d = await startDaemon(cfg);
      const stop = async () => {
        await d.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "mcp":
      return startMcp(cfg);
    case "who": {
      const { online } = await daemon.who(cfg);
      console.log(online.join("\n") || "nobody is online");
      return;
    }
    case "ask": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          kind: { type: "string", default: "question" },
          repo: { type: "string" },
          pr: { type: "string" },
          file: { type: "string", multiple: true },
          wait: { type: "boolean" },
          timeout: { type: "string", default: "600" },
        },
      });
      const [to, ...words] = positionals;
      if (!to || !words.length) throw new Usage("inbox ask <to> <text…>");
      const { convo } = await daemon.send(cfg, {
        to,
        kind: values.kind as Kind,
        text: words.join(" "),
        context: { repo: values.repo, pr: values.pr, files: values.file },
      });
      if (!values.wait) return console.log(convo);
      console.error(`sent; waiting for ${to} (convo ${convo})`);
      return printReplyOrExit(await waitForReply(cfg, convo, Number(values.timeout)));
    }
    case "wait": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { timeout: { type: "string", default: "600" } },
      });
      const convo = positionals[0];
      if (!convo) throw new Usage("inbox wait <convo> [--timeout secs]");
      return printReplyOrExit(await waitForReply(cfg, convo, Number(values.timeout)));
    }
    case "reply": {
      const [convo, ...words] = rest;
      if (!convo || !words.length) throw new Usage("inbox reply <convo> <text…>");
      await daemon.reply(cfg, convo, words.join(" "));
      return;
    }
    case "list": {
      for (const m of (await daemon.list(cfg)).messages)
        console.log(`${m.convo}  ${m.from}  [${m.kind}]  ${m.text.replace(/\s+/g, " ")}`);
      return;
    }
    case "watch": {
      const res = await fetch("http://daemon/watch", { unix: cfg.socket } as RequestInit).catch(() => null);
      if (!res?.body) throw new DaemonError(`no daemon at ${cfg.socket}; start it with \`inbox up\``, "no_daemon");
      for await (const chunk of res.body) process.stdout.write(chunk);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exit(1);
  }
}

class Usage extends Error {}

function printReplyOrExit(reply: Awaited<ReturnType<typeof waitForReply>>) {
  if (!reply) {
    console.error("no reply before the timeout");
    process.exit(2);
  }
  console.log(`${reply.from}: ${reply.text}`);
}

main().catch((err) => {
  if (err instanceof Usage) console.error(`usage: ${err.message}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(err instanceof DaemonError && err.code === "offline" ? 3 : 1);
});
