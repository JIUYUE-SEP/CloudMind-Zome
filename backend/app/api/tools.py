"""Tools metadata API: list available tools grouped by toolset."""

from __future__ import annotations

from fastapi import APIRouter

from engine.tool.registry import tool_registry

router = APIRouter(prefix="/tools", tags=["tools"])

# ------------------------------------------------------------------
# Human-readable labels (toolset + per-tool)
# ------------------------------------------------------------------
_TOOLSET_LABELS: dict[str, str] = {
    "file": "文件操作",
    "shell": "系统命令",
    "code": "代码执行",
    "web": "网络",
    "project": "项目管理",
    "comms": "通讯",
    "group": "群组",
}

_TOOL_LABELS: dict[str, str] = {
    "read_file": "读取文件",
    "write_file": "写入文件",
    "edit_file": "编辑文件",
    "delete_file": "删除文件",
    "share_file": "分享文件",
    "shell_command": "执行命令",
    "python_execute": "执行 Python",
    "search_web": "网页搜索",
    "generate_image": "生成图片",
    "list_project_docs": "列出项目文档",
    "search_project_docs": "搜索项目文档",
    "stay_silent": "保持沉默",
    "send_private_message": "私聊消息",
    "report_workflow_progress": "汇报工作流进度",
}


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@router.get("/available")
async def list_available_tools():
    """Return all registered tools grouped by toolset.

    Used by the frontend AgentEdit page so users can pick which
    toolsets (and individual tools) an agent is allowed to use.
    """
    toolset_map: dict[str, list[dict]] = {}
    for name, info in tool_registry._tools.items():
        ts = info.get("toolset", "default")
        toolset_map.setdefault(ts, []).append({
            "name": name,
            "label": _TOOL_LABELS.get(name, name),
        })

    result: dict[str, dict] = {}
    for ts, tools in sorted(toolset_map.items()):
        result[ts] = {
            "label": _TOOLSET_LABELS.get(ts, ts),
            "tools": tools,
        }

    return {"code": 0, "data": {"toolsets": result}}
