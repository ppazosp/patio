import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseMode, decidePermission } from "../src/acp";
import type { Config } from "../src/config";
import { startDaemon } from "../src/daemon";
import { daemon, DaemonError, waitForReply } from "../src/local";
import { startRelay } from "../src/relay";

const quiet = () => {};
let relay: ReturnType<typeof startRelay>;
let stops: Array<() => Promise<void>> = [];

async function person(handle: string, rulesYaml?: string, token?: string): Promise<Config> {
  const home = await mkdtemp(join(tmpdir(), `inbox-${handle}-`));
  if (rulesYaml) await writeFile(join(home, "rules.yaml"), rulesYaml);
  const cfg: Config = { home, handle, token, relay: `ws://127.0.0.1:${relay.port}`, socket: join(home, "daemon.sock") };
  const d = await startDaemon(cfg, { log: quiet });
  stops.push(d.stop);
  for (let i = 0; i < 50 && !d.isConnected(); i++) await Bun.sleep(20);
  return cfg;
}

beforeAll(() => {
  process.env.INBOX_NO_NOTIFY = "1";
  relay = startRelay({ port: 0, users: new Map([["pablo", "p-token"], ["miguel", "m-token"], ["ana", "a-token"]]), log: quiet });
});

afterAll(async () => {
  for (const stop of stops) await stop();
  relay.stop(true);
});

test("a question reaches an online person and their rule answers it", async () => {
  // Miguel's rule: answer questions with a script that reads the message on stdin.
  const miguel = await person(
    "miguel",
    `default: notify
rules:
  - match: { kind: question }
    do: run
    command: ["bun", "-e", "const m = await Bun.stdin.json(); console.log('PR ' + m.context.pr + ' is green, merging today: ask me')"]
`,
    "m-token",
  );
  const pablo = await person("pablo", undefined, "p-token");

  expect((await daemon.who(pablo)).online).toEqual(["miguel", "pablo"]);

  const { convo } = await daemon.send(pablo, { to: "miguel", kind: "question", text: "Will PR 812 merge?", context: { pr: "812" } });
  const reply = await waitForReply(pablo, convo, 10);
  expect(reply?.from).toBe("miguel");
  expect(reply?.kind).toBe("reply");
  expect(reply?.text).toContain("PR 812 is green");

  // Miguel's machine kept the incoming question so a person can see it.
  expect((await daemon.list(miguel)).messages.map((m) => m.convo)).toContain(convo);
});

test("a reply that arrives before anyone waits is kept until someone does", async () => {
  const pablo = await person("pablo", undefined, "p-token");
  const ana = await person("ana", undefined, "a-token"); // default rule: notify, a person answers by hand
  const { convo } = await daemon.send(pablo, { to: "ana", kind: "question", text: "Is the migration done?" });
  await Bun.sleep(100);
  await daemon.reply(ana, convo, "Yes, ran it at 10:00");
  await Bun.sleep(100);
  const reply = await waitForReply(pablo, convo, 2);
  expect(reply?.text).toBe("Yes, ran it at 10:00");
  expect(reply?.from).toBe("ana");
});

test("sending to someone offline fails straight away", async () => {
  const pablo = await person("pablo", undefined, "p-token");
  const err = await daemon.send(pablo, { to: "nobody", kind: "question", text: "hello?" }).catch((e) => e);
  expect(err).toBeInstanceOf(DaemonError);
  expect((err as DaemonError).code).toBe("offline");
});

test("wait times out cleanly when no reply comes", async () => {
  const pablo = await person("pablo", undefined, "p-token");
  const started = Date.now();
  expect(await waitForReply(pablo, "no-such-convo", 1)).toBeNull();
  expect(Date.now() - started).toBeLessThan(3000);
});

test("refuse rule answers with a refusal", async () => {
  await person("ana", "default: refuse\n", "a-token");
  const pablo = await person("pablo", undefined, "p-token");
  const { convo } = await daemon.send(pablo, { to: "ana", kind: "request", text: "rename this" });
  expect((await waitForReply(pablo, convo, 5))?.text).toContain("do not accept");
});

test("a second daemon on the same home refuses to start", async () => {
  const pablo = await person("pablo", undefined, "p-token");
  expect(startDaemon(pablo, { log: quiet })).rejects.toThrow("already running");
  expect((await daemon.status(pablo)).connected).toBe(true);
});

test("the relay rejects a wrong token", async () => {
  const home = await mkdtemp(join(tmpdir(), "inbox-spoof-"));
  const cfg: Config = { home, handle: "miguel", token: "wrong", relay: `ws://127.0.0.1:${relay.port}`, socket: join(home, "daemon.sock") };
  const d = await startDaemon(cfg, { log: quiet });
  stops.push(d.stop);
  await Bun.sleep(300);
  expect(d.isConnected()).toBe(false);
});

test("sessions are moved out of approve-everything modes, or refused", () => {
  const modes = (current: string, ids: string[]) => ({
    currentModeId: current,
    availableModes: ids.map((id) => ({ id, name: id })),
  });
  expect(chooseMode(modes("bypassPermissions", ["default", "plan", "bypassPermissions"]))).toEqual({ switchTo: "default" });
  expect(chooseMode(modes("auto", ["read-only", "auto", "full-access"]))).toEqual({ switchTo: "read-only" });
  expect(chooseMode(modes("default", ["default", "bypassPermissions"]))).toEqual({ keep: true });
  expect(chooseMode(modes("yolo", ["yolo"]))).toHaveProperty("refuse");
  expect(chooseMode(undefined)).toEqual({ keep: true });
});

test("read-only permissions allow reads and refuse edits", () => {
  const options = [
    { optionId: "yes", name: "Allow", kind: "allow_once" as const },
    { optionId: "no", name: "Reject", kind: "reject_once" as const },
  ];
  const ask = (kind: "read" | "edit" | "execute") =>
    decidePermission({ sessionId: "s", toolCall: { toolCallId: "t", kind }, options }, "read-only").outcome;
  expect(ask("read")).toEqual({ outcome: "selected", optionId: "yes" });
  expect(ask("edit")).toEqual({ outcome: "selected", optionId: "no" });
  expect(ask("execute")).toEqual({ outcome: "selected", optionId: "no" });
});
