import type { ModelSetup } from "../types/modelSetup";
import { modelLabel } from "../types/modelSetup";

export function modelStatusLabel(
  setup: ModelSetup | null,
  health: {
    demo?: boolean;
    model?: string;
    subagent_model?: string;
    provider?: string;
  } | null,
  role: "main" | "subagent" = "main",
): string {
  if (!setup && !health) return "";
  if (setup?.demo_mode || health?.demo) return "Demo";
  const ref = role === "subagent" ? setup?.subagent : setup?.main;
  const fromSetup = modelLabel(setup, ref);
  if (fromSetup) return fromSetup;
  const name =
    role === "subagent"
      ? health?.subagent_model || health?.model
      : health?.model;
  return name || health?.provider || "model";
}
