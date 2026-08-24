import { useState } from "react";
import type { ActivePlan, PlanTaskStatus } from "../types/plan";

export type { ActivePlan, PlanTask, PlanTaskStatus } from "../types/plan";

type Props = {
  plan: ActivePlan;
  subtitle: string;
  titleLabel: string;
  collapseLabel?: string;
  expandLabel?: string;
  /** Default collapsed to keep the chat viewport free. */
  defaultCollapsed?: boolean;
};

function statusClass(status: PlanTaskStatus): string {
  if (status === "done") return "done";
  if (status === "running") return "running";
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

export function TaskPlanPanel({
  plan,
  subtitle,
  titleLabel,
  collapseLabel = "收起",
  expandLabel = "展开",
  defaultCollapsed = true,
}: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const done = plan.tasks.filter((x) => x.status === "done").length;
  const running = plan.tasks.find((x) => x.status === "running");

  return (
    <div
      className={`plan-doc task-plan plan-doc-compact${collapsed ? " collapsed" : ""}`}
      role="region"
      aria-label={titleLabel}
    >
      <button
        type="button"
        className="plan-doc-head task-plan-head"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="plan-doc-head-main">
          <span className="plan-doc-badge">{titleLabel}</span>
          <strong className="plan-doc-heading">{plan.summary || titleLabel}</strong>
          <span className="plan-doc-overview">
            {subtitle}
            {running ? ` · ${running.title}` : ""}
          </span>
        </span>
        <span className="plan-doc-toggle" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="sr-only">{collapsed ? expandLabel : collapseLabel}</span>
      </button>
      {!collapsed && (
        <ol className="plan-doc-list plan-doc-list-compact">
          {plan.tasks.map((task, i) => (
            <li
              key={task.id || i}
              className={`plan-doc-item status-${task.status}`}
              title={task.detail || ""}
            >
              <span className={`plan-index ${statusClass(task.status)}`} aria-hidden>
                {i + 1}
              </span>
              <span className="plan-doc-text">
                <span className="plan-doc-task-title">{task.title}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {collapsed && (
        <div className="plan-doc-mini-progress" aria-hidden>
          <span>
            {done}/{plan.tasks.length}
          </span>
        </div>
      )}
    </div>
  );
}
