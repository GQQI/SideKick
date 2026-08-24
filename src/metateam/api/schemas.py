"""Request bodies for the HTTP API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: str | None = None
    mode: str = "agent"
    display: str | None = None


class MemoryUpdate(BaseModel):
    content: str


class MemoryLibraryUpdate(BaseModel):
    version: int = 1
    categories: list[dict[str, Any]] = Field(default_factory=list)


class ModelUpdate(BaseModel):
    version: int | None = None
    providers: list[dict[str, Any]] | None = None
    main: dict[str, Any] | None = None
    subagent: dict[str, Any] | None = None
    compress: dict[str, Any] | None = None
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    subagent_model: str | None = None
    compress_model: str | None = None
    review_model: str | None = None
    reasoning_effort: str | None = None
    thinking_enabled: bool | None = None
    demo_mode: bool | None = None
    temperature: float | None = None


class ModelSelect(BaseModel):
    role: str
    provider_id: str
    model: str


class WorkspaceSet(BaseModel):
    path: str | None = None
    name: str | None = None
    create: bool = False


class WorkspaceCreate(BaseModel):
    path: str | None = None
    name: str | None = None


class FileWrite(BaseModel):
    path: str = Field(..., min_length=1)
    content: str = ""


class FileCreate(BaseModel):
    path: str = Field(..., min_length=1)
    kind: str = "file"


class FileRename(BaseModel):
    path: str = Field(..., min_length=1)
    new_name: str = Field(..., min_length=1)


class FileMove(BaseModel):
    path: str = Field(..., min_length=1)
    dest_dir: str = "."


class FileReveal(BaseModel):
    path: str = "."


class UndoBody(BaseModel):
    id: str | None = None


class GitPathsBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class GitCommitBody(BaseModel):
    message: str = ""


class GitCheckoutBody(BaseModel):
    branch: str = Field(..., min_length=1, max_length=200)
    create: bool = False


class GitRemoteBody(BaseModel):
    url: str = Field(..., min_length=3, max_length=500)
    name: str = "origin"


class AuthSetupBody(BaseModel):
    username: str = Field(..., min_length=2)
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=6)


class AuthLoginBody(BaseModel):
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=1)
    username: str | None = None


class AuthCreateUserBody(BaseModel):
    username: str = Field(..., min_length=2)
    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=6)


class McpUpdateBody(BaseModel):
    version: int | None = 1
    servers: list[dict[str, Any]] = Field(default_factory=list)


class McpTestBody(BaseModel):
    id: str = ""
    name: str = ""
    transport: str = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class TruncateBody(BaseModel):
    keep_user_turns: int = Field(0, ge=0)
    restore_files: bool = False


class ApprovalDecision(BaseModel):
    approved: bool
    remember: bool = False
    patch_args: dict[str, Any] | None = None


class AskAnswer(BaseModel):
    choice: str = ""
    text: str = ""
    option_label: str = ""


class PlanConfirm(BaseModel):
    approved: bool = True
    summary: str | None = None
    tasks: list[dict[str, Any]] | None = None


class BrowserStartBody(BaseModel):
    url: str = ""
    headless: bool = False


class BrowserNavigateBody(BaseModel):
    url: str


class BrowserPickBody(BaseModel):
    timeout_ms: int = 60000
    with_screenshot: bool = True
