/** The remote MCP endpoint for the current deployment. Production serves the
 *  connector on the dedicated mcp.* hosts (oauth resource identity); the legacy
 *  www origin still proxies /mcp for existing sessions. Local/dev keeps the
 *  same-origin path. */
export function mcpEndpointUrl(): string {
  if (typeof window === "undefined") return "";
  const { origin, hostname } = window.location;
  if (hostname === "www.lynse.ai" || hostname === "lynse.ai") return "https://mcp.lynse.ai/mcp";
  if (hostname === "www.lynse.cn" || hostname === "lynse.cn") return "https://mcp.lynse.cn/mcp";
  return `${origin}/mcp`;
}
