"""MCP tool discovery and registration into the tool registry.

Design reference: §6.14.3 启动流程, §6.14.4 调用流程
"""

from __future__ import annotations

import logging

from ..config.models import AppConfig, ToolItemConfig
from ..tool.registry import ToolRegistry
from .client import MCPClient

logger = logging.getLogger(__name__)


class MCPDiscovery:
    """Discovers MCP servers from config and registers their tools."""

    def __init__(self, config: AppConfig, registry: ToolRegistry):
        self.config = config
        self.registry = registry
        self._clients: dict[str, MCPClient] = {}

    async def discover_all(self) -> list[str]:
        """Connect to all configured MCP servers and register tools.

        Returns:
            List of successfully connected server names.
        """
        connected = []

        for name, cfg in self.config.tools.mcp_servers.items():
            client = MCPClient(
                name=name,
                command=cfg.command or None,
                args=cfg.args,
                url=None,  # TODO: Support URL-based MCP
                env=cfg.env,
                timeout=cfg.timeout,
                connect_timeout=cfg.connect_timeout,
                supports_parallel=cfg.supports_parallel_tool_calls,
            )

            success = await client.connect()
            self._clients[name] = client

            if success:
                # Register tools
                for tool in client.tools:
                    self._register_mcp_tool(name, tool, client)
                connected.append(name)
            else:
                # Register with available=False (§6.14.4)
                for tool in client.tools:
                    self._register_mcp_tool(name, tool, client, available=False)
                logger.warning(
                    "MCP server %s unavailable, tools registered but marked unavailable",
                    name,
                )

        return connected

    def _register_mcp_tool(
        self,
        server_name: str,
        tool: dict,
        client: MCPClient,
        available: bool = True,
    ) -> None:
        """Register a single MCP tool into the registry."""
        tool_name = tool["name"]
        full_name = f"mcp_{server_name}_{tool_name}"

        # Build OpenAI-compatible schema
        schema = {
            "type": "function",
            "function": {
                "name": full_name,
                "description": tool.get("description", f"MCP tool: {tool_name}"),
                "parameters": tool.get("input_schema", {"type": "object", "properties": {}}),
            },
        }

        # Store in registry
        self.registry._tools[full_name] = {
            "func": None,  # MCP tools are called via client, not directly
            "toolset": f"mcp-{server_name}",
            "schema": schema,
            "max_result_chars": 50000,
            "safe_to_parallel": client.supports_parallel,
            "timeout": client.timeout,
            "is_async": True,
            "_mcp_client": client,
            "_mcp_tool_name": tool_name,
            "_available": available,
        }

    def get_client(self, server_name: str) -> MCPClient | None:
        """Get MCP client by server name."""
        return self._clients.get(server_name)

    async def call_tool(self, full_name: str, arguments: dict) -> str:
        """Call an MCP tool by its full registered name."""
        tool_info = self.registry._tools.get(full_name)
        if not tool_info:
            raise RuntimeError(f"MCP tool {full_name} not found")

        if not tool_info.get("_available", True):
            raise RuntimeError(
                f"MCP server unavailable for tool {full_name}. "
                "Please check the server status."
            )

        client: MCPClient = tool_info["_mcp_client"]
        tool_name: str = tool_info["_mcp_tool_name"]
        return await client.call_tool(tool_name, arguments)
