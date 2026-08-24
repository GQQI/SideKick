"""HTTP route modules."""

from fastapi import FastAPI

from . import auth, browser, chat, files, git, sessions, system, workspaces


def register_routes(app: FastAPI) -> None:
    app.include_router(system.router)
    app.include_router(auth.router)
    app.include_router(workspaces.router)
    app.include_router(files.router)
    app.include_router(git.router)
    app.include_router(sessions.router)
    app.include_router(chat.router)
    app.include_router(browser.router)
