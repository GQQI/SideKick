"""User-facing git panel (stage / unstage / commit / remote sync)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ...services import git_ops
from ..http import git_result_or_400, resolve_panel_workspace
from ..schemas import GitCheckoutBody, GitCommitBody, GitPathsBody, GitRemoteBody

router = APIRouter(prefix="/api/git", tags=["git"])


def _ok_snap(ws: Any, message: str = "ok") -> dict[str, Any]:
    snap = git_ops.panel_snapshot(ws)
    snap["status"] = "ok"
    snap["message"] = message
    return snap


@router.get("")
def api_git_status(workspace: str | None = None) -> dict[str, Any]:
    return git_ops.panel_snapshot(resolve_panel_workspace(workspace))


@router.get("/review")
def api_git_review(
    session_id: str | None = Query(None, max_length=200),
    workspace: str | None = None,
) -> dict[str, Any]:
    return git_ops.review_panel_snapshot(
        resolve_panel_workspace(workspace), session_id=session_id
    )


@router.get("/file-diff")
def api_git_file_diff(
    path: str = Query(..., min_length=1, max_length=500),
    session_id: str | None = Query(None, max_length=200),
    workspace: str | None = None,
) -> dict[str, Any]:
    try:
        return git_ops.file_change_pair(
            resolve_panel_workspace(workspace), path, session_id=session_id
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/stage")
def api_git_stage(body: GitPathsBody) -> dict[str, Any]:
    ws = resolve_panel_workspace(body.workspace)
    git_result_or_400(git_ops.stage_paths(ws, list(body.paths or [])))
    return _ok_snap(ws)


@router.post("/unstage")
def api_git_unstage(body: GitPathsBody) -> dict[str, Any]:
    ws = resolve_panel_workspace(body.workspace)
    git_result_or_400(git_ops.unstage_paths(ws, list(body.paths or [])))
    return _ok_snap(ws)


@router.post("/commit")
def api_git_commit(body: GitCommitBody) -> dict[str, Any]:
    ws = resolve_panel_workspace(body.workspace)
    result = git_result_or_400(git_ops.commit_staged(ws, body.message))
    return _ok_snap(ws, result)


@router.post("/fetch")
def api_git_fetch(workspace: str | None = None) -> dict[str, Any]:
    ws = resolve_panel_workspace(workspace)
    result = git_result_or_400(git_ops.fetch_remote(ws))
    return _ok_snap(ws, result)


@router.post("/pull")
def api_git_pull(workspace: str | None = None) -> dict[str, Any]:
    ws = resolve_panel_workspace(workspace)
    result = git_result_or_400(git_ops.pull_remote(ws))
    return _ok_snap(ws, result)


@router.post("/push")
def api_git_push(workspace: str | None = None) -> dict[str, Any]:
    ws = resolve_panel_workspace(workspace)
    result = git_result_or_400(git_ops.push_remote(ws))
    return _ok_snap(ws, result)


@router.post("/checkout")
def api_git_checkout(body: GitCheckoutBody) -> dict[str, Any]:
    ws = resolve_panel_workspace(body.workspace)
    try:
        result = git_ops.checkout_branch(ws, body.branch, create=body.create)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    git_result_or_400(result)
    return _ok_snap(ws, result)


@router.post("/remote")
def api_git_remote(body: GitRemoteBody) -> dict[str, Any]:
    ws = resolve_panel_workspace(body.workspace)
    try:
        result = git_ops.set_remote_url(ws, body.url, name=body.name or "origin")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    git_result_or_400(result)
    return _ok_snap(ws, result)
