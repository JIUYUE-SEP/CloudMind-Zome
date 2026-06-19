"""Restricted Python runner used by the code execution tool.

The subprocess created by python_execute imports this module to set up a
restricted execution environment before running untrusted user code.
"""
from __future__ import annotations

import builtins
import sys
from typing import Any

# Modules that may not be imported at all inside the sandbox.
_BLOCKED_MODULES = frozenset({
    "os", "sys", "subprocess", "shutil", "socket", "urllib", "http",
    "ftplib", "smtplib", "ctypes", "mmap", "resource", "signal",
    "multiprocessing", "concurrent", "threading", "asyncio", "importlib",
    "pathlib", "io", "builtins", "pkgutil", "platform", "site",
    "zipfile", "tarfile", "pickle", "marshal", "shelve", "dbm",
})

# Builtins that are too dangerous for arbitrary code execution.
_BLOCKED_BUILTINS = frozenset({
    "open", "exec", "eval", "compile", "__import__", "input",
    "breakpoint", "exit", "quit", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "hasattr",
})


class _RestrictedImportFinder:
    """Meta path finder that blocks imports of dangerous modules."""

    def find_module(self, fullname: str, path: str | None = None) -> Any:
        top = fullname.split(".")[0]
        if top in _BLOCKED_MODULES:
            raise ImportError(f"Sandbox: import of {fullname!r} is blocked")
        return None


def _install_import_blocker() -> None:
    finder = _RestrictedImportFinder()
    # Keep our own finder at the front so it runs first.
    sys.meta_path.insert(0, finder)


def _safe_builtins() -> dict[str, Any]:
    """Return a copy of builtins with dangerous names removed."""
    safe: dict[str, Any] = {}
    for name in dir(builtins):
        if name.startswith("__"):
            # Keep dunder helpers that normal code relies on (e.g. len, str).
            safe[name] = getattr(builtins, name)
        elif name not in _BLOCKED_BUILTINS:
            safe[name] = getattr(builtins, name)
    return safe


def run_restricted(user_code: str) -> None:
    """Execute user_code in a restricted namespace."""
    _install_import_blocker()

    safe = _safe_builtins()
    if "__build_class__" not in safe:
        safe["__build_class__"] = builtins.__build_class__

    # Hardening: disable object.__subclasses__ so common introspection escapes
    # (e.g. ().__class__.__bases__[0].__subclasses__()) cannot enumerate types.
    def _blocked_subclasses(_self: type) -> Any:
        raise AttributeError("Sandbox: __subclasses__ is disabled")

    try:
        type.__setattr__(object, "__subclasses__", _blocked_subclasses)
    except TypeError:
        # Some Python builds do not allow mutating object methods; the import
        # blocker and restricted builtins still provide the primary defense.
        pass

    restricted_globals: dict[str, Any] = {
        "__builtins__": safe,
        "__name__": "__main__",
        "__doc__": None,
        "__package__": None,
        "__spec__": None,
    }

    exec(user_code, restricted_globals)


if __name__ == "__main__":
    import sys as _sys

    if len(_sys.argv) != 2:
        print("Usage: sandbox_runner.py <base64-encoded-code>", file=_sys.stderr)
        _sys.exit(2)

    import base64
    encoded = _sys.argv[1]
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except Exception as exc:
        print(f"Failed to decode user code: {exc}", file=_sys.stderr)
        _sys.exit(2)

    try:
        run_restricted(decoded)
    except Exception as exc:
        print(f"Sandbox error: {type(exc).__name__}: {exc}", file=_sys.stderr)
        _sys.exit(1)
