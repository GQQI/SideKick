"""Background shell jobs API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ...services.shell_jobs import JOBS

router = APIRouter(prefix="/api/shell-jobs", tags=["shell-jobs"])


@router.get("")
def api_shell_jobs(include_done: bool = True) -> dict[str, Any]:
    jobs = [j.snapshot(tail=20) for j in JOBS.list(include_done=bool(include_done))]
    return {"jobs": jobs, "running": sum(1 for j in jobs if j.get("status") == "running")}


@router.get("/{job_id}")
def api_shell_job(job_id: str, tail: int = 80) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"unknown job {job_id}")
    return job.snapshot(tail=max(10, min(int(tail or 80), 400)))


@router.post("/{job_id}/stop")
def api_shell_job_stop(job_id: str) -> dict[str, Any]:
    job = JOBS.stop(job_id)
    if not job:
        raise HTTPException(404, f"unknown job {job_id}")
    return job.snapshot(tail=40)


@router.delete("/{job_id}")
def api_shell_job_delete(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"unknown job {job_id}")
    if job.alive():
        raise HTTPException(409, "job is still running — stop it first")
    JOBS.remove(job_id)
    return {"status": "ok", "job_id": job_id}
