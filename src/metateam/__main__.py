"""python -m metateam [serve|chat]"""

from __future__ import annotations

import sys


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "serve":
        from .api import main as serve_main

        serve_main()
        return 0
    from .cli import main as cli_main

    # strip accidental 'chat'
    if args and args[0] == "chat":
        sys.argv = [sys.argv[0], *args[1:]]
    return cli_main()


if __name__ == "__main__":
    raise SystemExit(main())
