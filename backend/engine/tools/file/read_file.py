"""Read file tool."""

from pathlib import Path
from pydantic import BaseModel, Field

from engine.tool.registry import tool_registry
from .security import is_safe_path


class ReadFileInput(BaseModel):
    """Validated input for read_file."""
    path: str = Field(..., min_length=1, description="File path to read.")
    encoding: str = Field(default="utf-8", min_length=1, description="Text encoding.")


@tool_registry.register(
    toolset="file",
    max_result_chars=12000,
    safe_to_parallel=True,
    input_schema=ReadFileInput,
    permission="file:read",
)
def read_file(path: str, encoding: str = "utf-8") -> str:
    """读取文本文件内容

    Args:
        path: 文件路径
        encoding: 编码格式，默认utf-8
    """
    ok, reason = is_safe_path(path, mode="read")
    if not ok:
        return f"Error: {reason}"

    try:
        content = Path(path).read_text(encoding=encoding)
        return content
    except Exception as e:
        return f"Error reading file: {e}"
