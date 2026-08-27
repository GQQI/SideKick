"""Workspace grounding and per-turn coherence policy."""

from __future__ import annotations

from typing import Any

from .coherence import format_turn_policy_block, merge_policy_into_system, policy_for_turn


class AgentGroundingMixin:
    def _ingest_workspace_fact(self, name: str, args: dict[str, Any], content: str) -> None:
        """Pin layout discoveries so the next user turn still respects them."""
        if self.is_subagent and not getattr(self, "full_agent", False):
            return
        key_tools = {
            "list_dir",
            "codebase_overview",
            "codebase_find_similar",
            "codebase_impact",
        }
        if name not in key_tools:
            if name == "read_file" and content.startswith("ERROR: not found"):
                path = str(args.get("path") or "")
                note = f"read_file missing: {path}"
            else:
                return
        else:
            preview = content.strip().replace("\r\n", "\n")
            if len(preview) > 600:
                preview = preview[:600] + "…"
            path_hint = str(args.get("path") or args.get("query") or args.get("symbol_or_path") or ".")
            note = f"{name}({path_hint}): {preview}"

        self.workspace_facts.append(note)
        if len(self.workspace_facts) > 8:
            self.workspace_facts = self.workspace_facts[-8:]

    def _refresh_workspace_grounding(self) -> None:
        """Rewrite pinned ground-truth in the system message each user turn."""
        if self.is_subagent and not getattr(self, "full_agent", False):
            return
        if not self.messages or self.messages[0].get("role") != "system":
            return

        ws = self.settings.workspace.resolve()
        lines = [
            "## Workspace ground truth (authoritative)",
            f"Root: {ws}",
            "Do NOT invent paths like src/, app/, components/ unless listed below or just confirmed by a tool this turn.",
            "If a previous tool showed only certain files (e.g. index.html), treat that as current reality until tools say otherwise.",
        ]
        try:
            from ..services import codebase_memory as cbm

            idx = cbm.get_or_build_index(ws)
            paths = [fe.path for fe in idx.files[:60]]
            lines.append(f"Indexed files ({len(idx.files)}):")
            if paths:
                lines.extend(f"- {p}" for p in paths)
            else:
                lines.append("- (none)")
        except Exception as exc:  # noqa: BLE001
            from ..core.logutil import get_logger, log_exception

            log_exception(get_logger("metateam.agent"), "grounding index failed", exc)

        try:
            entries = sorted(ws.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            shown = []
            for e in entries[:40]:
                if e.name.startswith(".") and e.name not in {
                    ".sidekick",
                    ".yutianlang",
                    ".cursor",
                }:
                    continue
                shown.append(f"{'dir' if e.is_dir() else 'file'}:{e.name}")
            if shown:
                lines.append("Top-level now: " + ", ".join(shown))
            else:
                lines.append("Top-level now: (empty)")
        except OSError:
            pass

        if self.workspace_facts:
            lines.append("Session discoveries (from tools):")
            lines.extend(f"- {f}" for f in self.workspace_facts[-6:])

        try:
            from ..services.workspace_rules import load_workspace_rules

            rules = load_workspace_rules(ws)
            if rules:
                lines.append(rules)
        except Exception:
            pass

        try:
            from ..services.verify_detect import grounding_verify_hint

            hint = grounding_verify_hint(ws)
            if hint:
                lines.append(hint)
        except Exception:
            pass

        block = "\n".join(lines)
        marker = "## Workspace ground truth (authoritative)"
        content = str(self.messages[0].get("content") or "")
        if marker in content:
            content = content.split(marker, 1)[0].rstrip()
        old_cm = "## Codebase memory (structure projection)"
        if old_cm in content:
            head, _, tail = content.partition(old_cm)
            rest = tail.split("\n## ", 1)
            if len(rest) == 2:
                content = (head.rstrip() + "\n\n## " + rest[1]).strip()
            else:
                content = head.rstrip()

        self.messages[0]["content"] = (content.rstrip() + "\n\n" + block).strip()

    def _refresh_memory_block(self) -> None:
        """Replace the ## Memory section with the current MEMORY.md contents."""
        if self.is_subagent and not getattr(self, "full_agent", False):
            return
        if not self.messages or self.messages[0].get("role") != "system":
            return
        from ..services.memory import format_memory_block

        new_block = format_memory_block(self.settings.memory_file)
        content = str(self.messages[0].get("content") or "")
        marker = "## Memory"
        if marker in content:
            head, _, rest = content.partition(marker)
            tail_parts = rest.split("\n## ", 1)
            after = ("\n## " + tail_parts[1]) if len(tail_parts) == 2 else ""
            body = head.rstrip()
            if new_block.strip():
                body = (body + "\n\n" + new_block.strip()).strip()
            self.messages[0]["content"] = (body + after).strip()
            return
        if new_block.strip():
            self.messages[0]["content"] = (content.rstrip() + "\n\n" + new_block.strip()).strip()

    def _apply_turn_coherence_policy(self, user_text: str) -> None:
        """Pin per-turn Anti-Piling policy (align/contract/pile) into system message."""
        if self.is_subagent:
            return
        if not self.messages or self.messages[0].get("role") != "system":
            return
        policy = policy_for_turn(user_text)
        self._turn_policy = policy
        block = format_turn_policy_block(policy)
        self.messages[0]["content"] = merge_policy_into_system(
            str(self.messages[0].get("content") or ""),
            block,
        )
        self._emit(
            "coherence_policy",
            {
                "kind": policy.label,
                "require_align": policy.require_align,
                "require_shape_contract": policy.require_shape_contract,
                "require_pile_check": policy.require_pile_check,
                "message": f"连贯策略：{policy.label}",
            },
        )
