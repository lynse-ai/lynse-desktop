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
const DOWNLOADS_URL = "https://www.lynse.cn/app/downloads";

export const CLI_VERSION = "1.8.12";
export const MCP_CN_VERSION = "0.2.2";
export const CLI_WHEEL_URL = `${DOWNLOADS_URL}/lynse_cli-${CLI_VERSION}-py3-none-any.whl`;
export const CLI_INSTALL_COMMAND = `uv tool install --force "${CLI_WHEEL_URL}"`;
export const CLI_SIGN_IN_COMMAND = "lynse auth login --device";
export const CLI_EXAMPLE_COMMAND = "lynse meetings list --days 7";
export const CLI_SKILL_URL = `${DOWNLOADS_URL}/lynse-cli-skill-${CLI_VERSION}.zip`;
export const CLI_WORKBUDDY_SKILL_URL = `${DOWNLOADS_URL}/lynse-cli-skill-workbuddy-${CLI_VERSION}.zip`;
export const MCP_WORKBUDDY_CN_URL = `${DOWNLOADS_URL}/lynse-mcp-workbuddy-cn-${MCP_CN_VERSION}.zip`;
