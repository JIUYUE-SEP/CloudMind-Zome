"""Read file tool."""

from pathlib import Path
from engine.tool.registry import tool_registry


@tool_registry.register(toolset="file", max_result_chars=12000, safe_to_parallel=True)
def read_file(path: str, encoding: str = "utf-8") -> str:
    """读取文本文件内容

    Args:
        path: 文件路径
        encoding: 编码格式，默认utf-8
    """
    try:
        content = Path(path).read_text(encoding=encoding)
        return content
    except Exception as e:
        return f"Error reading file: {e}"
