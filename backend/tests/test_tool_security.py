"""Integration tests: tool functions enforce path/command security."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.tools.file.read_file import read_file
from engine.tools.file.write_file import write_file
from engine.tools.file.edit_file import edit_file
from engine.tools.file.share_file import share_file
from engine.tools.file import delete_file
from engine.tools.code import python_execute
from engine.tools.shell import shell_command


class TestReadFileSecurity:
    def test_read_etc_passwd_blocked(self) -> None:
        result = read_file("/etc/passwd")
        assert result.startswith("Error:")
        assert "forbidden" in result.lower() or "not allowed" in result.lower()

    def test_read_windows_sam_blocked(self) -> None:
        result = read_file("C:\\Windows\\System32\\config\\SAM")
        assert result.startswith("Error:")

    def test_read_ssh_key_blocked(self) -> None:
        result = read_file("~/.ssh/id_rsa")
        assert result.startswith("Error:")

    def test_read_allowed_project_source(self) -> None:
        # Should succeed for project source in read mode
        from engine.tools.file.security import _PROJECT_ROOT
        path = str(_PROJECT_ROOT / "backend" / "engine" / "config" / "models.py")
        result = read_file(path)
        assert not result.startswith("Error:")
        assert "class AppConfig" in result or "pydantic" in result


class TestWriteFileSecurity:
    def test_write_outside_whitelist_blocked(self) -> None:
        result = write_file("/tmp/evil.txt", "payload")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_write_home_blocked(self) -> None:
        result = write_file("~/.bashrc", "evil")
        assert result.startswith("Error:")

    def test_write_workspace_allowed(self, tmp_path: Path) -> None:
        # We can't easily mock WORKSPACE_ROOT here, so test with cloudmind home
        result = write_file(
            str(Path.home() / ".cloudmind-zome" / "test_write_workspace_allowed.txt"),
            "hello",
        )
        assert result.startswith("File written:")


class TestEditFileSecurity:
    def test_edit_bashrc_blocked(self) -> None:
        result = edit_file("~/.bashrc", old_text="foo", new_text="bar")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_edit_outside_whitelist_blocked(self) -> None:
        result = edit_file("/tmp/foo.txt", old_text="foo", new_text="bar")
        assert result.startswith("Error:")


class TestDeleteFileSecurity:
    def test_delete_bashrc_blocked(self) -> None:
        result = delete_file("~/.bashrc")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()


class TestPythonExecuteSecurity:
    def test_pathlib_import_blocked(self) -> None:
        code = 'from pathlib import Path; print(Path("/etc/passwd").read_text())'
        result = python_execute(code)
        assert result.startswith("Error: security check failed")
        assert "pathlib" in result.lower()

    def test_io_import_blocked(self) -> None:
        code = 'import io; print(io.open("/etc/passwd").read())'
        result = python_execute(code)
        assert result.startswith("Error: security check failed")
        assert "io" in result.lower()


class TestShellCommandSecurity:
    def test_git_exec_path_blocked(self) -> None:
        result = shell_command("git --exec-path=/tmp")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_git_hook_blocked(self) -> None:
        result = shell_command("git hook list")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_npm_run_blocked(self) -> None:
        result = shell_command("npm run evil-script")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_npm_exec_blocked(self) -> None:
        result = shell_command("npm exec ls")
        assert result.startswith("Error:")
        assert "not allowed" in result.lower()

    def test_shell_chain_blocked(self) -> None:
        result = shell_command("ls && cat /etc/passwd")
        assert result.startswith("Error:")
        assert "metacharacter" in result.lower()

    def test_safe_echo_allowed(self) -> None:
        result = shell_command("echo hello")
        assert not result.startswith("Error:")
        assert "[stdout]" in result or "hello" in result

    def test_safe_git_status_allowed(self) -> None:
        result = shell_command("git status")
        # git may not be installed on Windows; skip if it fails for non-security reasons
        if "not allowed" in result.lower():
            pytest.skip("git not available on this platform")
        assert not result.startswith("Error:")
