"""Official Python MCP SDK client for the two-client Stateplane gate.

The orchestrator sends one JSON command per stdin line and reads one JSON reply
per stdout line. The bearer comes only from STATEPLANE_MCP_TOKEN, never argv.
Replies contain tool results or a transport error class, never the bearer.
"""
import asyncio
import importlib.metadata
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client


def reply(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


def dump(result):
    data = result.model_dump(mode="json", by_alias=True, exclude_none=True)
    return {"isError": bool(data.get("isError")), "structuredContent": data.get("structuredContent"),
            "text": next((item.get("text") for item in data.get("content", []) if item.get("type") == "text"), None)}


async def main():
    url = os.environ["STATEPLANE_MCP_URL"]
    token = os.environ.pop("STATEPLANE_MCP_TOKEN")
    client = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    async with client:
        async with streamable_http_client(url, http_client=client) as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                reply({"ready": True, "sdk": "mcp (Python)", "sdkVersion": importlib.metadata.version("mcp"),
                       "protocolVersion": initialized.protocol_version,
                       "server": initialized.server_info.name})
                loop = asyncio.get_running_loop()
                while True:
                    line = await loop.run_in_executor(None, sys.stdin.readline)
                    if not line:
                        return
                    command = json.loads(line)
                    try:
                        if command["op"] == "list":
                            tools = await session.list_tools()
                            reply({"tools": sorted(tool.name for tool in tools.tools)})
                        elif command["op"] == "call":
                            reply(dump(await session.call_tool(command["tool"], command.get("arguments", {}))))
                        else:
                            return
                    except Exception as error:  # A transport or auth failure is the observed outcome.
                        reply({"transportError": type(error).__name__})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BaseException as error:  # Session teardown after a rejected credential.
        reply({"transportError": type(error).__name__})
