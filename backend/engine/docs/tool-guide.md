# Tool Guide for CloudMind-Zome

## How Tools Work

Tools are functions registered via `@tool_registry.register()` decorator.
The registry auto-discovers all tools at startup by scanning `engine/tools/`.

## Tool Registration

### Minimal Example
```python
from ...tool.registry import tool_registry

@tool_registry.register(toolset="file", max_result_chars=2000)
def my_tool(param: str) -> str:
    """Description here."""
    return f"Result: {param}"
```

### Decorator Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| toolset | "default" | Category: web/file/code/shell/comms |
| max_result_chars | 12000 | Result truncation limit |
| safe_to_parallel | True | Can run with other tools |
| timeout | None | Max seconds (None = 60 default) |

### Toolset Categories
| Toolset | Existing Tools |
|---------|---------------|
| web | search_web, generate_image |
| file | read_file, write_file, edit_file, delete_file, share_file |
| code | python_execute |
| shell | shell_command |
| comms | send_private_message, report_workflow_progress |

## Adding a New Tool

### Step 1: Create the file
```
backend/engine/tools/{toolset}/my_tool.py
```

### Step 2: Write the function
```python
from __future__ import annotations
from ...tool.registry import tool_registry

@tool_registry.register(toolset="web", max_result_chars=1000)
async def fetch_url(url: str) -> str:
    """Fetch content from a URL.
    
    Args:
        url: The URL to fetch.
    """
    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, timeout=30)
        return resp.text[:1000]
```

### Step 3: Restart backend
Tool discovery runs at startup. No manual registration needed.

### Important Rules
1. Use `from __future__ import annotations` at top
2. Import `tool_registry` with relative import: `from ...tool.registry import tool_registry`
3. Write clear docstrings with `Args:` section (used for schema generation)
4. For sync functions, use `def` (runs in ThreadPoolExecutor)
5. For async functions, use `async def` (runs directly in event loop)
6. Return `str` for text results, `dict` for structured data
7. Return error messages starting with "Error:"

## Tool Schema Auto-Generation

The registry inspects function signature and docstring to generate OpenAI function schema:
- Parameter names and types → JSON schema properties
- `Args:` section → parameter descriptions
- Docstring first paragraph → tool description
- Default values → optional parameters

## File Locations
| Purpose | Path |
|---------|------|
| Registry | `backend/engine/tool/registry.py` |
| Discovery | `backend/app/main.py` line ~56 |
| Tool directory | `backend/engine/tools/` |

## Modifying Existing Tools

1. Read the tool file with `read_file`
2. Edit with `edit_file` (recommended) or `write_file` (full overwrite)
3. Restart backend for discovery to pick up changes
