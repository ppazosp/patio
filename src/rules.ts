// The receiver's rules: what happens on this machine when a message arrives.
// The sender never decides this.
import { join } from "node:path";
import { expandHome } from "./config";
import type { Kind, Message } from "./protocol";

export type Action = "notify" | "run" | "agent" | "refuse";
export type Permissions = "read-only" | "none";

export type Rule = {
  match?: { kind?: Kind | Kind[]; from?: string | string[] };
  do: Action;
  // run: a command that gets the message as JSON on stdin; its stdout, if any, is sent back as the reply.
  command?: string[];
  // agent: a preset name or a full command that speaks ACP over stdio.
  agent?: string;
  cwd?: string;
  permissions?: Permissions;
};

export type Rules = {
  default: Action;
  rules: Rule[];
  limits: { agent_runs_per_day: number };
};

// Pinned so a new adapter release cannot change behaviour under you.
export const AGENT_PRESETS: Record<string, string[]> = {
  claude: ["bunx", "@agentclientprotocol/claude-agent-acp@0.101.0"],
  codex: ["bunx", "@agentclientprotocol/codex-acp@2.5.0"],
  gemini: ["gemini", "--acp"],
};

const ACTIONS: Action[] = ["notify", "run", "agent", "refuse"];

export const DEFAULT_RULES: Rules = { default: "notify", rules: [], limits: { agent_runs_per_day: 10 } };

export async function loadRules(home: string): Promise<Rules> {
  const file = Bun.file(join(home, "rules.yaml"));
  if (!(await file.exists())) return DEFAULT_RULES;
  const raw = (Bun.YAML.parse(await file.text()) ?? {}) as Partial<Rules>;
  const rules: Rules = {
    default: raw.default ?? DEFAULT_RULES.default,
    rules: raw.rules ?? [],
    limits: { ...DEFAULT_RULES.limits, ...raw.limits },
  };
  // Catch settings written at the top level, where they would be silently ignored.
  for (const key of Object.keys(raw))
    if (!["default", "rules", "limits"].includes(key))
      throw new Error(`rules.yaml: unknown top-level key "${key}"; agent, command, cwd and permissions go inside a rule`);
  // agent and run need settings that only a rule can carry.
  if (rules.default !== "notify" && rules.default !== "refuse")
    throw new Error(`rules.yaml: default must be notify or refuse; for agent or run, add a rule (match: {} matches everything)`);
  rules.rules.forEach((rule, i) => {
    const where = `rules.yaml: rule ${i + 1}`;
    if (!ACTIONS.includes(rule.do)) throw new Error(`${where}: do must be one of ${ACTIONS.join(", ")}`);
    if (rule.do === "run" && !rule.command?.length) throw new Error(`${where}: run needs a command`);
    if (rule.do === "agent") {
      if (!rule.agent) throw new Error(`${where}: agent needs agent: claude | codex | gemini | "<command>"`);
      if (!rule.cwd) throw new Error(`${where}: agent needs a cwd`);
      if (rule.permissions && rule.permissions !== "read-only" && rule.permissions !== "none")
        throw new Error(`${where}: permissions must be read-only or none`);
    }
  });
  return rules;
}

const asList = <T>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

export function pickRule(rules: Rules, msg: Message): Rule {
  for (const rule of rules.rules) {
    const kinds = asList(rule.match?.kind);
    const froms = asList(rule.match?.from);
    if (kinds && !kinds.includes(msg.kind)) continue;
    if (froms && !froms.includes(msg.from) && !froms.includes("*")) continue;
    return rule;
  }
  return { do: rules.default };
}

export function agentCommand(rule: Rule): string[] {
  const name = rule.agent!;
  return AGENT_PRESETS[name] ?? name.split(" ").filter(Boolean);
}

export function agentCwd(rule: Rule): string {
  return expandHome(rule.cwd!);
}
