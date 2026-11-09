/** The remote MCP endpoint for the current deployment. The web app and the
 *  MCP service share the origin (nginx proxies /mcp), so the connector
 *  address derives from where the page is served. */
export function mcpEndpointUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/mcp`;
}
