"""Tests for unified file-tool path security."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.tools.file.security import is_safe_path, set_agent_allowed_paths


class TestBlacklist:
    """Blacklist must block system-critical paths regardless of mode."""

    @pytest.mark.parametrize(
        "path",
        [
            "/etc/passwd",
            "/etc/shadow",
            "/usr/bin/python",
            "/bin/bash",
            "/boot/grub/grub.cfg",
            "/root/.bashrc",
            "C:\\Windows\\System32\\config\\SAM",
            "C:\\Windows\\System32\\drivers\\etc\\hosts",
        ],
    )
    def test_system_paths_blocked(self, path: str) -> None:
        for mode in ("read", "write", "delete", "share"):
            ok, reason = is_safe_path(path, mode=mode)
            assert not ok, f"{path} should be blocked in {mode} mode"
            assert "forbidden" in reason.lower() or "not allowed" in reason.lower()

    @pytest.mark.parametrize(
        "path",
        [
            "~/.ssh/id_rsa",
            "~/.ssh/authorized_keys",
            "~/.gnupg/private-keys-v1.d/key.gpg",
            "~/.aws/credentials",
            "~/.kube/config",
        ],
    )
    def test_sensitive_user_paths_blocked(self, path: str) -> None:
        for mode in ("read", "write", "delete", "share"):
            ok, reason = is_safe_path(path, mode=mode)
            assert not ok, f"{path} should be blocked in {mode} mode"


class TestReadWhitelist:
    """Read mode has the widest whitelist (includes project source)."""

    def test_can_read_project_source(self) -> None:
        # Project root is whitelisted for read
        ok, _ = is_safe_path("backend/engine/config/models.py", mode="read")
        assert ok

    def test_can_read_workspace(self) -> None:
        from engine.tools.file.security import WORKSPACE_ROOT
        ok, _ = is_safe_path(str(WORKSPACE_ROOT / "dummy" / "file.txt"), mode="read")
        assert ok

    def test_can_read_cloudmind_home(self) -> None:
        ok, _ = is_safe_path("~/.cloudmind-zome/settings.json", mode="read")
        assert ok

    def test_home_dir_blocked_for_read(self) -> None:
        # ~/.bashrc is blocked by blacklist anyway, but even something benign
        # outside whitelist should be blocked
        ok, reason = is_safe_path("~/random.txt", mode="read")
        # Note: ~/random.txt resolves to Path.home() / "random.txt" which may
        # or may not be under .cloudmind-zome.  It is NOT, so it should be blocked.
        assert not ok
        assert "allowed" in reason.lower()


class TestWriteWhitelist:
    """Write/delete mode has a strict whitelist."""

    def test_project_source_blocked_for_write(self) -> None:
        from engine.tools.file.security import _PROJECT_ROOT
        ok, _ = is_safe_path(str(_PROJECT_ROOT / "backend" / "engine" / "config" / "models.py"), mode="write")
        assert not ok

    def test_workspace_allowed_for_write(self) -> None:
        from engine.tools.file.security import WORKSPACE_ROOT
        ok, _ = is_safe_path(str(WORKSPACE_ROOT / "dummy" / "file.txt"), mode="write")
        assert ok

    def test_cloudmind_home_allowed_for_write(self) -> None:
        ok, _ = is_safe_path("~/.cloudmind-zome/settings.json", mode="write")
        assert ok


class TestAgentAllowedPaths:
    """Per-agent configured paths extend the whitelist."""

    def test_agent_path_extends_read(self) -> None:
        set_agent_allowed_paths(["/tmp/agent_workspace"])
        ok, _ = is_safe_path("/tmp/agent_workspace/note.txt", mode="read")
        assert ok

    def test_agent_path_extends_write(self) -> None:
        set_agent_allowed_paths(["/tmp/agent_workspace"])
        ok, _ = is_safe_path("/tmp/agent_workspace/note.txt", mode="write")
        assert ok

    def test_agent_path_does_not_override_blacklist(self) -> None:
        set_agent_allowed_paths(["/etc"])
        ok, reason = is_safe_path("/etc/passwd", mode="read")
        assert not ok
        assert "forbidden" in reason.lower()

    def test_agent_path_explicit_param(self) -> None:
        ok, _ = is_safe_path(
            "/tmp/foo/bar.txt",
            mode="write",
            agent_allowed_paths=["/tmp/foo"],
        )
        assert ok


class TestSymlink:
    """Symlinks are resolved before checking."""

    def test_symlink_to_blacklisted_blocked(self, tmp_path: Path) -> None:
        # Create a symlink pointing to /etc/passwd inside a whitelisted dir
        whitelisted = tmp_path / "workspace"
        whitelisted.mkdir()
        symlink = whitelisted / "evil"
        try:
            symlink.symlink_to("/etc/passwd")
        except OSError:
            pytest.skip("symlink creation not supported on this platform")
        ok, reason = is_safe_path(str(symlink), mode="read")
        assert not ok
        assert "forbidden" in reason.lower()
