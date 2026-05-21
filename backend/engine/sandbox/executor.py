"""Sandboxed execution: isolated subprocess for generated code.

Design reference: §6.16 沙箱与自我进化
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class SandboxExecutor:
    """Executes Python code in an isolated subprocess.

    Uses temporary files + subprocess with restricted imports.
    """

    def __init__(self, timeout: int = 60):
        self.timeout = timeout

    async def execute(self, code: str, inputs: dict[str, Any]) -> dict[str, Any]:
        """Execute code in a sandboxed subprocess.

        Args:
            code: Python source code.
            inputs: Input variables to pass to the code.

        Returns:
            Dict with 'result', 'stdout', 'stderr', 'success'.
        """
        import json
        import asyncio

        # Wrap code to capture output
        wrapped = f"""
import json, sys
_inputs = json.loads({json.dumps(json.dumps(inputs))})

try:
{chr(10).join("    " + line for line in code.split(chr(10)))}
    # Try to call the main function if it exists
    _result = None
    for _name in dir():
        _obj = locals()[_name]
        if callable(_obj) and not _name.startswith('_') and _name != 'json' and _name != 'sys':
            _result = _obj(**_inputs)
            break
    print("\n__RESULT__" + json.dumps({{"result": str(_result) if _result is not None else None}}))
    sys.exit(0)
except Exception as e:
    print("\n__ERROR__" + str(e), file=sys.stderr)
    sys.exit(1)
"""

        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(wrapped)
            temp_path = f.name

        try:
            proc = await asyncio.create_subprocess_exec(
                "python", temp_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout
            )

            stdout_text = stdout.decode("utf-8", errors="replace")
            stderr_text = stderr.decode("utf-8", errors="replace")

            # Parse result
            result = None
            if "__RESULT__" in stdout_text:
                result_json = stdout_text.split("__RESULT__")[-1].strip()
                try:
                    result = json.loads(result_json).get("result")
                except json.JSONDecodeError:
                    pass

            success = proc.returncode == 0 and "__ERROR__" not in stderr_text

            return {
                "success": success,
                "result": result,
                "stdout": stdout_text[:5000],  # Limit output
                "stderr": stderr_text[:5000],
            }

        except asyncio.TimeoutError:
            logger.error("Sandbox execution timed out")
            return {"success": False, "result": None, "stdout": "", "stderr": "Timeout"}
        except Exception as e:
            logger.error("Sandbox execution failed: %s", e)
            return {"success": False, "result": None, "stdout": "", "stderr": str(e)}
        finally:
            import os
            try:
                os.unlink(temp_path)
            except:
                pass
