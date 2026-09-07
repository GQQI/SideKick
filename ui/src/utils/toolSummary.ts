/** Client-side tool call summaries for chips / streaming. */

function short(text: string, n = 80) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function nlines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function formatToolSummary(name: string, args: unknown, fallback = ""): string {
  if (fallback) return fallback;
  const a =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");

  if (name === "write_file") {
    const path = str("path") || "（路径待定）";
    const content = str("content");
    return `写入 ${path}${content ? `（${nlines(content)} 行）` : ""}`;
  }
  if (name === "str_replace") {
    const path = str("path") || "（路径待定）";
    const old = str("old_string") || str("oldString");
    const neu = str("new_string") || str("newString");
    const mode = a.replace_all || a.replaceAll ? "全部" : "1 处";
    if (old || neu) {
      return `替换 ${path}（${mode} · −${nlines(old)}/+${nlines(neu)} 行）`;
    }
    return `替换 ${path}`;
  }
  if (name === "delete_file") return `删除 ${str("path")}`;
  if (name === "read_file") {
    const path = str("path");
    const offset = typeof a.offset === "number" ? a.offset : Number(a.offset || 0);
    const limit = typeof a.limit === "number" ? a.limit : Number(a.limit || 0);
    if (!path) return "读取文件";
    if (offset > 1 || limit > 0) {
      const start = offset > 0 ? offset : 1;
      return limit > 0 ? `读取 ${path} · ${start}+${limit} 行` : `读取 ${path} · 自第 ${start} 行`;
    }
    return `读取 ${path}`;
  }
  if (name === "list_dir") return `列出 ${str("path") || "."}`;
  if (name === "search_text") {
    const q = str("query") || str("pattern");
    return `搜索 “${short(q, 40)}” @ ${str("path") || "."}`;
  }
  if (name === "run_shell") {
    const bg = a.background ? " · 后台" : "";
    return `shell${bg}: ${short(str("command"), 100)}`;
  }
  if (name === "shell_job_list") return "列出后台脚本";
  if (name === "shell_job_log") return `后台日志 ${str("job_id")}`;
  if (name === "shell_job_wait") return `等待后台任务 ${str("job_id")}`;
  if (name === "shell_job_stop") return `停止后台任务 ${str("job_id")}`;
  if (name === "git_status") return `git status @ ${str("path") || "."}`;
  if (name === "git_diff") {
    const mode = a.staged ? "staged" : "worktree";
    return `git diff (${mode}) ${str("path") || "all"}`;
  }
  if (name === "git_log") return `git log ×${a.max_count || 20}`;
  if (name === "git_commit") return `git commit: ${short(str("message"), 80)}`;
  if (name === "skill_save") return `保存技能 ${str("name")}`;
  if (name === "memory_append") return `追加记忆: ${short(str("note"), 80)}`;
  if (name === "memory_remove") return `删除记忆: ${short(str("match"), 80)}`;
  if (name === "memory_write") return `覆写记忆（${str("content").length} 字符）`;
  if (name === "memory_read") return "读取记忆";
  if (name === "delegate_task") {
    const tasks = Array.isArray(a.tasks) ? a.tasks : [];
    if (tasks.length > 1) return `委派 ${tasks.length} 个智能体`;
    const first =
      tasks[0] && typeof tasks[0] === "object" && !Array.isArray(tasks[0])
        ? String((tasks[0] as { goal?: string }).goal || "")
        : "";
    const goal = str("goal") || str("task") || str("query") || first;
    if (!goal) return "委派智能体";
    return `委派: ${short(goal, 80)}`;
  }
  if (name === "delegate_dialogue") {
    const speakers = Array.isArray(a.speakers) ? a.speakers : [];
    const topic = str("topic");
    if (topic) return `对话: ${short(topic, 80)}`;
    if (speakers.length) return `对话 · ${speakers.length} 方`;
    return "多方对话";
  }
  if (name === "ask_user") return `询问用户: ${short(str("question"), 80)}`;
  if (name === "browser_navigate") return `浏览器打开 ${short(str("url"), 80)}`;
  if (name === "browser_screenshot") return "浏览器截图";
  if (name === "browser_console") return "浏览器 console";
  if (name === "browser_click") return `浏览器点击 ${short(str("selector"), 60)}`;
  if (name === "browser_type") return `浏览器输入 ${short(str("selector"), 40)}`;
  if (name === "browser_find_elements") return "浏览器扫描可点击元素";
  if (name === "browser_scroll") {
    const dir = str("direction") || "down";
    const sel = str("selector");
    return sel ? `浏览器滚动到 ${short(sel, 40)}` : `浏览器滚动 (${dir})`;
  }
  if (name === "browser_hover") return `浏览器悬停 ${short(str("selector"), 60)}`;
  if (name === "browser_press_key") return `浏览器按键 ${short(str("key"), 20)}`;
  if (name === "browser_wait") return `浏览器等待 ${short(str("selector") || "…", 40)}`;
  if (name === "browser_go_back") return "浏览器后退";
  if (name === "browser_go_forward") return "浏览器前进";
  if (name.startsWith("skill_")) return `调用技能 ${name}`;
  for (const key of ["path", "command", "query", "name", "goal", "note", "question"]) {
    if (str(key)) return `${name}: ${short(str(key), 80)}`;
  }
  return name || "tool";
}
