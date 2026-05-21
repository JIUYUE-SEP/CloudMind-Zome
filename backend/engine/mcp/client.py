"""MCP client: connect to external MCP servers via stdio/HTTP/SSE.

Design reference: §6.14 MCP 支持
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class MCPClient:
    """MCP client wrapper.

    Handles connection to MCP servers via:
    - stdio (command + args)
    - HTTP (url)
    - SSE (url + transport=sse)
    """

    def __init__(
        self,
        name: str,
        command: str | None = None,
        args: list[str] | None = None,
        url: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int = 120,
        connect_timeout: int = 60,
        supports_parallel: bool = False,
    ):
        self.name = name
        self.command = command
        self.args = args or []
        self.url = url
        self.env = env or {}
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.supports_parallel = supports_parallel

        self._available = True
        self._tools: list[dict] = []

    async def connect(self) -> bool:
        """Connect to the MCP server and discover tools.

        Returns:
            True if connected successfully, False otherwise.
        """
        try:
            # Try to import the mcp package
            try:
                from mcp import ClientSession, StdioServerParameters
                from mcp.client.stdio import stdio_client
                HAVE_MCP = True
            except ImportError:
                HAVE_MCP = False

            if not HAVE_MCP:
                logger.warning("mcp package not installed, MCP support disabled")
                self._available = False
                return False

            if self.url:
                # HTTP/SSE transport
                # TODO: Implement HTTP MCP client
                logger.info("HTTP MCP transport not yet implemented: %s", self.url)
                self._available = False
                return False
            elif self.command:
                # stdio transport
                params = StdioServerParameters(
                    command=self.command,
                    args=self.args,
                    env={**os.environ, **self.env},
                )
                async with stdio_client(params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        self._tools = [
                            {
                                "name": tool.name,
                                "description": tool.description or "",
                                "input_schema": tool.inputSchema,
                            }
                            for tool in tools_result.tools
                        ]
                        logger.info(
                            "MCP server %s connected, %d tools discovered",
                            self.name,
                            len(self._tools),
                        )
                        return True
            else:
                logger.error("MCP server %s: neither command nor url specified", self.name)
                self._available = False
                return False

        except Exception as e:
            logger.warning("Failed to connect to MCP server %s: %s", self.name, e)
            self._available = False
            return False

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Call a tool on the MCP server.

        Args:
            tool_name: Name of the tool to call.
            arguments: Tool arguments.

        Returns:
            Tool result as string.
        """
        if not self._available:
            raise RuntimeError(f"MCP server {self.name} is not available")

        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client

            params = StdioServerParameters(
                command=self.command,
                args=self.args,
                env={**os.environ, **self.env},
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(tool_name, arguments=arguments)
                    return "\n".join(
                        item.text for item in result.content if hasattr(item, "text")
                    )
        except Exception as e:
            raise RuntimeError(f"MCP tool call failed: {e}") from e

    @property
    def available(self) -> bool:
        """Whether the MCP server is available."""
        return self._available

    @property
    def tools(self) -> list[dict]:
        """List of discovered tools."""
        return self._tools