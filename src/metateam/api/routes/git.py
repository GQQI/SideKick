"""User-facing git panel (stage / unstage / commit / remote sync)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ...core.config import get_settings
from ...services import git_ops
from ..http import git_result_or_400
from ..schemas import GitCheckoutBody, GitCommitBody, GitPathsBody, GitRemoteBody

router = APIRouter(prefix="/api/git", tags=["git"])


def _ok_snap(message: str = "ok") -> dict[str, Any]:
    snap = git_ops.panel_snapshot(get_settings().workspace)
    snap["status"] = "ok"
    snap["message"] = message
    return snap


@router.get("")
def api_git_status() -> dict[str, Any]:
    return git_ops.panel_snapshot(get_settings().workspace)


@router.get("/review")
def api_git_review(
    session_id: str | None = Query(None, max_length=200),
) -> dict[str, Any]:
    return git_ops.review_panel_snapshot(get_settings().workspace, session_id=session_id)


@router.get("/file-diff")
def api_git_file_diff(
    path: str = Query(..., min_length=1, max_length=500),
    session_id: str | None = Query(None, max_length=200),
) -> dict[str, Any]:
    try:
        return git_ops.file_change_pair(
            get_settings().workspace, path, session_id=session_id
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/stage")
def api_git_stage(body: GitPathsBody) -> dict[str, Any]:
    git_result_or_400(git_ops.stage_paths(get_settings().workspace, list(body.paths or [])))
    return _ok_snap()


@router.post("/unstage")
def api_git_unstage(body: GitPathsBody) -> dict[str, Any]:
    git_result_or_400(git_ops.unstage_paths(get_settings().workspace, list(body.paths or [])))
    return _ok_snap()


@router.post("/commit")
def api_git_commit(body: GitCommitBody) -> dict[str, Any]:
    result = git_result_or_400(git_ops.commit_staged(get_settings().workspace, body.message))
    return _ok_snap(result)


@router.post("/fetch")
def api_git_fetch() -> dict[str, Any]:
    result = git_result_or_400(git_ops.fetch_remote(get_settings().workspace))
    return _ok_snap(result)


@router.post("/pull")
def api_git_pull() -> dict[str, Any]:
    result = git_result_or_400(git_ops.pull_remote(get_settings().workspace))
    return _ok_snap(result)


@router.post("/push")
def api_git_push() -> dict[str, Any]:
    result = git_result_or_400(git_ops.push_remote(get_settings().workspace))
    return _ok_snap(result)


@router.post("/checkout")
def api_git_checkout(body: GitCheckoutBody) -> dict[str, Any]:
    try:
        result = git_ops.checkout_branch(
            get_settings().workspace, body.branch, create=body.create
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    git_result_or_400(result)
    return _ok_snap(result)


@router.post("/remote")
def api_git_remote(body: GitRemoteBody) -> dict[str, Any]:
    try:
        result = git_ops.set_remote_url(
            get_settings().workspace, body.url, name=body.name or "origin"
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    git_result_or_400(result)
    return _ok_snap(result)
