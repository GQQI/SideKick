import type { SkillItem } from "../api";
import { SLASH_DESC, type Locale } from "../i18n";

export type SlashCommandDef = {
  id: string;
  name: string;
  aliases?: string[];
  description: string;
  argsHint?: string;
  /** If true, selecting from menu inserts `/name ` instead of running. */
  needsArgs?: boolean;
};

export type SlashMenuItem = {
  id: string;
  /** Full insert text without trailing space handling, e.g. `/skills` or `/skill hello` */
  insert: string;
  label: string;
  description: string;
  kind: "command" | "skill";
  needsArgs?: boolean;
  /** Command name used for routing (without slash). */
  route: string;
  args?: string;
};

export const BASE_COMMANDS: SlashCommandDef[] = [
  {
    id: "help",
    name: "help",
    aliases: ["?", "commands"],
    description: "列出全部快捷命令",
  },
  {
    id: "new",
    name: "new",
    aliases: ["reset"],
    description: "开启新对话",
  },
  {
    id: "stop",
    name: "stop",
    aliases: ["cancel"],
    description: "停止当前生成",
  },
  {
    id: "clear",
    name: "clear",
    description: "清空当前对话界面（不删历史文件）",
  },
  {
    id: "history",
    name: "history",
    aliases: ["sessions", "hs"],
    description: "打开历史会话",
  },
  {
    id: "save",
    name: "save",
    description: "保存当前会话到磁盘",
  },
  {
    id: "skills",
    name: "skills",
    aliases: ["skill-list"],
    description: "查看全部 Skills",
  },
  {
    id: "skill",
    name: "skill",
    aliases: ["run"],
    description: "调用指定 Skill，可在名称后附加指令",
    argsHint: "<名称> [指令]",
    needsArgs: true,
  },
  {
    id: "memory",
    name: "memory",
    aliases: ["mem"],
    description: "查看记忆；可加 edit / refresh",
    argsHint: "[edit|refresh]",
  },
  {
    id: "model",
    name: "model",
    aliases: ["llm"],
    description: "打开模型设置",
  },
  {
    id: "workspace",
    name: "workspace",
    aliases: ["ws", "cwd"],
    description: "打开工作区设置",
  },
  {
    id: "runtime",
    name: "runtime",
    aliases: ["live"],
    description: "打开运行时事件面板",
  },
  {
    id: "stats",
    name: "stats",
    aliases: ["ctx", "context"],
    description: "查看上下文与迭代统计",
  },
  {
    id: "files",
    name: "files",
    aliases: ["explorer"],
    description: "展开文件浏览器",
  },
  {
    id: "browser",
    name: "browser",
    aliases: ["preview", "sandbox"],
    description: "打开浏览器沙盒（Select Mode）",
  },
  {
    id: "settings",
    name: "settings",
    aliases: ["config"],
    description: "打开设置",
  },
];

export function parseSlashLine(raw: string): { name: string; args: string } | null {
  const text = raw.trim().replace(/^／/, "/");
  if (!text.startsWith("/")) return null;
  const body = text.slice(1).trim();
  if (!body) return { name: "", args: "" };
  const sp = body.search(/\s/);
  if (sp < 0) return { name: body.toLowerCase(), args: "" };
  return {
    name: body.slice(0, sp).toLowerCase(),
    args: body.slice(sp + 1).trim(),
  };
}

/** True when input looks like an incomplete/complete slash command (for menu). */
export function slashMenuQuery(input: string): string | null {
  // Allow leading spaces; normalize fullwidth slash
  const trimmed = input.replace(/^\s+/, "");
  const normalized = trimmed.replace(/^／/, "/").replace(/^∕/, "/");
  if (!normalized.startsWith("/")) return null;
  if (normalized.includes("\n")) return null;
  return normalized.slice(1);
}

function matchesToken(cmd: SlashCommandDef, token: string): boolean {
  const t = token.toLowerCase();
  if (!t) return true;
  if (cmd.name.startsWith(t)) return true;
  return (cmd.aliases || []).some((a) => a.startsWith(t) || a.includes(t));
}

function resolveCommand(name: string): SlashCommandDef | undefined {
  const n = name.toLowerCase();
  return BASE_COMMANDS.find(
    (c) => c.name === n || (c.aliases || []).includes(n),
  );
}

export function buildSlashMenuItems(
  queryAfterSlash: string,
  skills: SkillItem[],
  locale: Locale = "zh",
): SlashMenuItem[] {
  const sp = queryAfterSlash.search(/\s/);
  const token = (sp < 0 ? queryAfterSlash : queryAfterSlash.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : queryAfterSlash.slice(sp + 1).trim();

  // `/skill xxx …` → filter skills by name token; keep trailing instructions on insert
  const skillCmd = resolveCommand(token);
  if (
    skillCmd &&
    (skillCmd.id === "skill" || skillCmd.name === "skill") &&
    sp >= 0
  ) {
    const nameToken = (rest.split(/\s+/)[0] || "").toLowerCase();
    const taskHint = rest.slice((rest.split(/\s+/)[0] || "").length).trim();
    return skills
      .filter(
        (s) =>
          !nameToken ||
          s.name.toLowerCase().includes(nameToken) ||
          s.tool.toLowerCase().includes(nameToken),
      )
      .slice(0, 12)
      .map((s) => ({
        id: `skill:${s.tool}`,
        insert: taskHint ? `/skill ${s.name} ${taskHint}` : `/skill ${s.name} `,
        label: taskHint ? `/skill ${s.name} ${taskHint}` : `/skill ${s.name} [指令]`,
        description: s.description || s.tool,
        kind: "skill" as const,
        route: "skill",
        needsArgs: !taskHint,
        args: taskHint ? `${s.name} ${taskHint}` : s.name,
      }));
  }

  const items: SlashMenuItem[] = [];

  for (const cmd of BASE_COMMANDS) {
    if (!matchesToken(cmd, token)) continue;
    const insert = cmd.argsHint ? `/${cmd.name} ` : `/${cmd.name}`;
    const localized = SLASH_DESC[cmd.id]?.[locale] || cmd.description;
    items.push({
      id: cmd.id,
      insert,
      label: cmd.argsHint ? `/${cmd.name} ${cmd.argsHint}` : `/${cmd.name}`,
      description: localized,
      kind: "command",
      needsArgs: Boolean(cmd.needsArgs),
      route: cmd.name,
    });
  }

  // Also surface skills as quick picks when query matches skill names
  if (token && !rest) {
    for (const s of skills) {
      const hay = `${s.name} ${s.tool}`.toLowerCase();
      if (!hay.includes(token) && !s.name.toLowerCase().startsWith(token)) continue;
      items.push({
        id: `skill:${s.tool}`,
        insert: `/skill ${s.name} `,
        label: `/skill ${s.name} [指令]`,
        description: s.description || s.tool,
        kind: "skill",
        route: "skill",
        needsArgs: true,
        args: s.name,
      });
    }
  }

  return items.slice(0, 14);
}

export function resolveSlashRoute(
  name: string,
): SlashCommandDef | undefined {
  return resolveCommand(name);
}

export function formatHelpText(locale: Locale = "zh"): string {
  const lines =
    locale === "en"
      ? ["**Slash commands**", ""]
      : ["**快捷命令**", ""];
  for (const c of BASE_COMMANDS) {
    const alias =
      c.aliases && c.aliases.length
        ? locale === "en"
          ? ` (aliases: ${c.aliases.map((a) => `/${a}`).join(", ")})`
          : `（别名：${c.aliases.map((a) => `/${a}`).join("、")}）`
        : "";
    const args = c.argsHint ? ` ${c.argsHint}` : "";
    const desc = SLASH_DESC[c.id]?.[locale] || c.description;
    lines.push(`\`/${c.name}${args}\` — ${desc}${alias}`);
  }
  lines.push(
    "",
    locale === "en"
      ? "Type `/` for the menu · ↑↓ select · Tab/Enter confirm · Esc close."
      : "输入 `/` 可打开命令菜单，↑↓ 选择，Tab/Enter 确认，Esc 关闭。",
  );
  return lines.join("\n");
}
