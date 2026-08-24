"""Small shared logging helpers — prefer these over silent `except: pass`."""

from __future__ import annotations

import logging
import sys


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s", "%H:%M:%S")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


def log_exception(logger: logging.Logger, msg: str, exc: BaseException | None = None) -> None:
    if exc is not None:
        logger.error("%s: %s", msg, exc, exc_info=True)
    else:
        logger.error("%s", msg)
