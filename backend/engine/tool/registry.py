"""Tool registry: decorator-based registration + automatic discovery.

Design reference: §6.5.2 工具注册与发现, §6.5.3 Schema 自动生成
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Bounded thread pool for sync tools to prevent unbounded thread leakage
# when wait_for timeout fires but the thread cannot be killed.
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tool-")

# Global tool registry instance
tool_registry = None  # Will be initialized below


class ToolRegistry:
    """Central registry for all tool functions.

    Supports decorator-based registration and directory auto-discovery.
    Generates OpenAI function calling schemas from function signatures
    and docstrings automatically.
    """

    def __init__(self) -> None:
        self._tools: dict[str, dict[str, Any]] = {}
        # _tools maps name -> {
        #   "func": callable,
        #   "toolset": str,
        #   "schema": dict,
        #   "max_result_chars": int,
        #   "safe_to_parallel": bool,
        #   "timeout": int | None,
        #   "is_async": bool,
        # }

    def register(
        self,
        toolset: str = "default",
        max_result_chars: int = 12000,
        safe_to_parallel: bool = True,
        timeout: int | None = None,
    ) -> Callable:
        """Decorator to register a tool function.

        Design reference: §6.5.2 装饰器注册

        Args:
            toolset: Tool set grouping (e.g. "web", "file", "code").
            max_result_chars: Max chars before truncation.
            safe_to_parallel: Whether this tool can run in parallel.
            timeout: Timeout in seconds for this tool.
        """

        def decorator(func: Callable) -> Callable:
            name = func.__name__
            schema = self._generate_schema(func)

            self._tools[name] = {
                "func": func,
                "toolset": toolset,
                "schema": schema,
                "max_result_chars": max_result_chars,
                "safe_to_parallel": safe_to_parallel,
                "timeout": timeout,
                "is_async": inspect.iscoroutinefunction(func),
            }

            # Attach schema to function for reference
            func.json_schema = schema
            return func

        return decorator

    def discover(
        self,
        tools_dir: str | Path,
        package: str = "tools",
    ) -> list[str]:
        """Auto-discover tool files in a directory (recursively).

        Design reference: §6.5.2 目录扫描自动发现

        Recursively scans the directory for Python files that contain
        ``@*.register(...)`` decorators and imports them automatically.
        Uses AST parsing instead of brittle string matching so alias
        imports (e.g. ``tr.register``) are detected and commented-out
        examples are ignored.

        Args:
            tools_dir: Path to the tools directory.
            package: Python package name for importlib (default "tools").
                If your tools live in ``my_project/plugins/``, pass
                ``package="my_project.plugins"``.

        Returns:
            List of discovered module names.
        """
        import ast

        tools_path = Path(tools_dir)
        imported: list[str] = []

        def _has_register_decorator(node: ast.AST) -> bool:
            """Return True if the node has any ``@*.register(...)`` decorator."""
            decos: list[ast.expr] = getattr(node, "decorator_list", [])
            for d in decos:
                # @foo.register(...)
                if isinstance(d, ast.Call):
                    func = d.func
                    if isinstance(func, ast.Attribute) and func.attr == "register":
                        return True
                # @foo.register
                if isinstance(d, ast.Attribute) and d.attr == "register":
                    return True
            return False

        def _scan_ast(tree: ast.AST) -> bool:
            """Walk the AST looking for any function/class with a .register decorator."""
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    if _has_register_decorator(node):
                        return True
            return False

        for py_file in sorted(tools_path.rglob("*.py")):
            if py_file.name.startswith("_") and py_file.name != "__init__.py":
                continue

            # Compute relative module path: e.g. web/search -> engine.tools.web.search
            rel_path = py_file.relative_to(tools_path)
            parts = list(rel_path.with_suffix("").parts)
            module_name = f"{package}.{'.'.join(parts)}"

            try:
                source = py_file.read_text(encoding="utf-8")
                try:
                    tree = ast.parse(source)
                except SyntaxError as exc:
                    logger.error(
                        "Tool file %s has syntax error (line %s, col %s): %s",
                        py_file, exc.lineno, exc.offset, exc.msg,
                    )
                    continue

                if not _scan_ast(tree):
                    continue

                import importlib

                importlib.import_module(module_name)
                imported.append(module_name)
                logger.info("Discovered tool module: %s", module_name)
            except Exception as e:
                logger.error(
                    "Failed to import tool module %s from %s: %s",
                    module_name, py_file, e, exc_info=True,
                )

        return imported

    def get_schemas(self, toolsets: list[str] | None = None) -> list[dict]:
        """Get OpenAI function calling schemas for registered tools.

        Args:
            toolsets: Only include tools from these toolsets. None = all.

        Returns:
            List of OpenAI-format tool schemas.
        """
        schemas = []
        for name, tool_info in self._tools.items():
            if toolsets is None or tool_info["toolset"] in toolsets:
                schemas.append(tool_info["schema"])
        return schemas

    def get_tool(self, name: str) -> dict[str, Any] | None:
        """Get tool info by name."""
        return self._tools.get(name)

    async def execute(self, name: str, arguments: dict[str, Any]) -> Any:
        """Execute a tool by name with given arguments.

        Design reference: §6.5.4 工具执行与并行策略, §6.5.5 结果裁剪与缓存

        Args:
            name: Tool function name.
            arguments: Arguments to pass to the tool.

        Returns:
            Tool result (str, dict, or list).

        Raises:
            ToolNotFoundError: If the tool is not registered.
            ToolTimeoutError: If the tool execution times out.
            ToolExecutionError: If the tool execution fails.
        """
        tool_info = self._tools.get(name)
        if tool_info is None:
            raise ToolNotFoundError(f"Tool '{name}' not found")

        # Check if this is an MCP tool
        if tool_info.get("_mcp_client"):
            if not tool_info.get("_available", True):
                raise ToolExecutionError(
                    f"MCP server unavailable for tool '{name}'. "
                    "Please check the server status."
                )
            client = tool_info["_mcp_client"]
            tool_name = tool_info["_mcp_tool_name"]
            return await client.call_tool(tool_name, arguments)

        func = tool_info["func"]
        timeout = tool_info.get("timeout") or 60

        try:
            if tool_info["is_async"]:
                result = await asyncio.wait_for(
                    func(**arguments), timeout=timeout
                )
            else:
                # Use bounded executor instead of asyncio.to_thread (which uses
                # a default unbounded-ish pool).  Python threads cannot truly be
                # killed, so the best we can do is cap the leak at max_workers.
                loop = asyncio.get_running_loop()
                fut = loop.run_in_executor(
                    _executor, lambda: func(**arguments)
                )
                result = await asyncio.wait_for(fut, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            raise ToolTimeoutError(f"Tool '{name}' timed out after {timeout}s")
        except Exception as e:
            raise ToolExecutionError(f"Tool '{name}' execution failed: {e}") from e

    def remove(self, name: str) -> None:
        """Remove a tool from the registry (used by skill decay)."""
        if name in self._tools:
            del self._tools[name]

    def list_tools(self, toolset: str | None = None) -> list[str]:
        """List all registered tool names, optionally filtered by toolset."""
        if toolset:
            return [
                name
                for name, info in self._tools.items()
                if info["toolset"] == toolset
            ]
        return list(self._tools.keys())

    # ------------------------------------------------------------------
    # Schema auto-generation from function signature + docstring
    # Design reference: §6.5.3
    # ------------------------------------------------------------------

    def _generate_schema(self, func: Callable) -> dict:
        """Generate OpenAI function calling schema from function signature and docstring."""
        sig = inspect.signature(func)
        docstring = inspect.getdoc(func) or ""
        params_doc = self._parse_docstring_params(docstring)
        description = self._parse_docstring_description(docstring, default=func.__name__)

        properties: dict[str, Any] = {}
        required: list[str] = []

        for param_name, param in sig.parameters.items():
            if param_name == "self":
                continue

            prop = self._python_type_to_json_schema(param.annotation, params_doc.get(param_name, ""))

            # Handle default values
            if param.default is inspect.Parameter.empty:
                required.append(param_name)
            else:
                prop["default"] = param.default

            properties[param_name] = prop

        return {
            "type": "function",
            "function": {
                "name": func.__name__,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        }

    @staticmethod
    def _parse_docstring_params(docstring: str) -> dict[str, str]:
        """Parse Args: section from docstring."""
        params = {}
        in_args = False
        for line in docstring.split("\n"):
            stripped = line.strip()
            if stripped.startswith("Args:"):
                in_args = True
                continue
            if in_args:
                if stripped and not stripped.startswith(" "):
                    break
                # Parse "param_name: description" or "param_name (type): description"
                match = re.match(r"\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(.+)", stripped)
                if match:
                    params[match.group(1)] = match.group(2).strip()
        return params

    @staticmethod
    def _parse_docstring_description(docstring: str, default: str = "") -> str:
        """Extract the first paragraph of a docstring as the description."""
        lines = docstring.split("\n")
        desc_lines = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("Args:") or stripped.startswith("Returns:"):
                break
            if stripped:
                desc_lines.append(stripped)
        return " ".join(desc_lines) if desc_lines else default

    @classmethod
    def _python_type_to_json_schema(cls, annotation: Any, description: str = "") -> dict[str, Any]:
        """Map a Python type annotation to a JSON Schema fragment (dict).

        Supports:
        - str / int / float / bool / list / dict
        - list[str], list[int], list[dict]  (recursive items)
        - dict[str, T]  (recursive additionalProperties)
        - Optional[T], Union[X, Y, None]
        - Literal["a", "b"]  (enum)
        - dataclass / TypedDict  (recursive object schema)
        """
        import sys
        import typing

        result: dict[str, Any] = {}
        if description:
            result["description"] = description

        if annotation is inspect.Parameter.empty:
            result["type"] = "string"
            return result

        # --- basic types ------------------------------------------------
        type_map = {
            str: "string",
            int: "integer",
            float: "number",
            bool: "boolean",
            list: "array",
            dict: "object",
        }
        if annotation in type_map:
            result["type"] = type_map[annotation]
            return result

        # --- typing.List / list[...] ------------------------------------
        origin = getattr(annotation, "__origin__", None)
        args = getattr(annotation, "__args__", ())

        if origin is list or annotation is list:
            result["type"] = "array"
            if args:
                item_schema = cls._python_type_to_json_schema(args[0])
                # flatten: remove description from nested item if present
                item_schema.pop("description", None)
                result["items"] = item_schema
            return result

        # --- typing.Dict / dict[str, T] ---------------------------------
        if origin is dict or annotation is dict:
            result["type"] = "object"
            if len(args) >= 2 and args[0] is str:
                val_schema = cls._python_type_to_json_schema(args[1])
                val_schema.pop("description", None)
                result["additionalProperties"] = val_schema
            return result

        # --- typing.Optional / Union[..., None] -------------------------
        if origin is typing.Union:
            non_none = [a for a in args if a is not type(None)]
            is_optional = len(non_none) < len(args)

            if len(non_none) == 1:
                # Optional[T]  ->  type of T, plus null if needed
                inner = cls._python_type_to_json_schema(non_none[0])
                result.update(inner)
                if is_optional:
                    existing_type = result.get("type")
                    if isinstance(existing_type, str):
                        result["type"] = [existing_type, "null"]
                    elif isinstance(existing_type, list):
                        if "null" not in existing_type:
                            result["type"] = list(existing_type) + ["null"]
                return result
            else:
                # Union[X, Y, ...]
                any_of = []
                for a in non_none:
                    sub = cls._python_type_to_json_schema(a)
                    sub.pop("description", None)
                    any_of.append(sub)
                if any_of:
                    result["anyOf"] = any_of
                if is_optional:
                    result["anyOf"].append({"type": "null"})
                return result

        # --- typing.Literal ---------------------------------------------
        try:
            if hasattr(annotation, "__args__") and getattr(annotation, "__origin__", None) is typing.Literal:
                result["enum"] = list(annotation.__args__)
                return result
        except Exception:
            pass

        # --- dataclass / TypedDict --------------------------------------
        if hasattr(annotation, "__annotations__"):
            result["type"] = "object"
            props: dict[str, Any] = {}
            req: list[str] = []
            for name, ann in annotation.__annotations__.items():
                field_default = getattr(annotation, name, inspect.Parameter.empty)
                field_required = field_default is inspect.Parameter.empty
                sub = cls._python_type_to_json_schema(ann)
                sub.pop("description", None)
                props[name] = sub
                if field_required:
                    req.append(name)
            result["properties"] = props
            if req:
                result["required"] = req
            return result

        # fallback
        result["type"] = "string"
        return result


# Custom exception types for tool errors
# Design reference: §6.9.5 工具执行错误处理

class ToolNotFoundError(Exception):
    """Tool not found in registry."""


class ToolTimeoutError(Exception):
    """Tool execution timed out."""


class ToolExecutionError(Exception):
    """Tool execution failed."""


# Initialize global registry
tool_registry = ToolRegistry()