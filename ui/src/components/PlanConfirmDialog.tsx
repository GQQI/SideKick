import { useEffect, useState } from "react";
import type { PlanTask } from "./TaskPlanPanel";

type DraftTask = {
  id: string;
  title: string;
  detail: string;
};

type Props = {
  summary: string;
  tasks: PlanTask[];
  titleLabel: string;
  dialogLabel: string;
  approveLabel: string;
  rejectLabel: string;
  addTaskLabel?: string;
  submitting: boolean;
  onApprove: (draft: { summary: string; tasks: PlanTask[] }) => void;
  onReject: () => void;
};

function toDraft(tasks: PlanTask[]): DraftTask[] {
  return tasks.map((t, i) => ({
    id: t.id || `task_${i}`,
    title: t.title || "",
    detail: t.detail || "",
  }));
}

function newTaskId(): string {
  return `task_${Math.random().toString(36).slice(2, 10)}`;
}

/** Compact plan confirm: summary + editable task titles, details optional/collapsed. */
export function PlanConfirmDialog({
  summary,
  tasks,
  titleLabel,
  dialogLabel,
  approveLabel,
  rejectLabel,
  addTaskLabel = "添加任务",
  submitting,
  onApprove,
  onReject,
}: Props) {
  const [draftSummary, setDraftSummary] = useState(summary);
  const [draftTasks, setDraftTasks] = useState<DraftTask[]>(() => toDraft(tasks));
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setDraftSummary(summary);
    setDraftTasks(toDraft(tasks));
  }, [summary, tasks]);

  function patchTask(id: string, patch: Partial<DraftTask>) {
    setDraftTasks((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function removeTask(id: string) {
    setDraftTasks((list) => (list.length <= 1 ? list : list.filter((t) => t.id !== id)));
  }

  function moveTask(id: string, dir: -1 | 1) {
    setDraftTasks((list) => {
      const i = list.findIndex((t) => t.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function addTask() {
    setDraftTasks((list) => [...list, { id: newTaskId(), title: "", detail: "" }]);
  }

  function handleBuild() {
    const cleaned = draftTasks
      .map((t) => ({
        id: t.id,
        title: t.title.trim(),
        detail: t.detail.trim(),
        status: "pending" as const,
      }))
      .filter((t) => t.title);
    onApprove({
      summary: draftSummary.trim() || summary,
      tasks:
        cleaned.length > 0
          ? cleaned
          : toDraft(tasks).map((t) => ({
              id: t.id,
              title: t.title || "步骤",
              detail: t.detail,
              status: "pending" as const,
            })),
    });
  }

  return (
    <div className="plan-doc inline-plan plan-doc-edit plan-doc-compact" role="dialog" aria-label={dialogLabel}>
      <div className="plan-doc-top">
        <span className="plan-doc-badge">{titleLabel}</span>
        <input
          className="plan-doc-summary-input"
          value={draftSummary}
          disabled={submitting}
          onChange={(e) => setDraftSummary(e.target.value)}
          placeholder={titleLabel}
        />
      </div>

      <ol className="plan-doc-list plan-doc-list-compact">
        {draftTasks.map((task, i) => (
          <li key={task.id} className="plan-doc-item plan-doc-item-edit">
            <span className="plan-index pending" aria-hidden>
              {i + 1}
            </span>
            <div className="plan-doc-text plan-doc-fields">
              <input
                className="plan-doc-title-input"
                value={task.title}
                disabled={submitting}
                placeholder={`任务 ${i + 1}`}
                onChange={(e) => patchTask(task.id, { title: e.target.value })}
              />
              {showDetails ? (
                <textarea
                  className="plan-doc-detail-input"
                  value={task.detail}
                  disabled={submitting}
                  rows={2}
                  placeholder="可选说明"
                  onChange={(e) => patchTask(task.id, { detail: e.target.value })}
                />
              ) : null}
            </div>
            <div className="plan-doc-task-ops">
              <button
                type="button"
                className="plan-doc-op"
                disabled={submitting || i === 0}
                title="上移"
                onClick={() => moveTask(task.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="plan-doc-op"
                disabled={submitting || i === draftTasks.length - 1}
                title="下移"
                onClick={() => moveTask(task.id, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="plan-doc-op danger"
                disabled={submitting || draftTasks.length <= 1}
                title="删除"
                onClick={() => removeTask(task.id)}
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="plan-doc-toolbar">
        <button type="button" className="plan-doc-add-task" disabled={submitting} onClick={addTask}>
          + {addTaskLabel}
        </button>
        <button
          type="button"
          className="plan-doc-toggle-details"
          disabled={submitting}
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "隐藏说明" : "编辑说明"}
        </button>
      </div>

      <div className="plan-doc-actions">
        <button type="button" className="plan-doc-dismiss" disabled={submitting} onClick={onReject}>
          {rejectLabel}
        </button>
        <button type="button" className="plan-doc-build" disabled={submitting} onClick={handleBuild}>
          {approveLabel}
        </button>
      </div>
    </div>
  );
}
