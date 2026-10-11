import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { currentMcpDependencies, McpInputError, readDesktopMcpTool } from "./mcp-data";

export interface DesktopMcpConfig { enabled: boolean; port: number; token: string }
export interface DesktopMcpApi {
  getConfig: () => Promise<DesktopMcpConfig>;
  configure: (enabled: boolean, port: number, rotate?: boolean) => Promise<DesktopMcpConfig>;
}
export const desktopMcpApi: DesktopMcpApi = {
  getConfig: () => invoke("desktop_mcp_get"),
  configure: (enabled, port, rotate = false) => invoke("desktop_mcp_configure", { enabled, port, rotate }),
};

export async function installDesktopMcpBridge(): Promise<void> {
  if (new URLSearchParams(window.location.search).get("window")) return;
  await getCurrentWebview().listen<{ requestId:string; name:string; arguments:Record<string, unknown> }>("lynse-mcp-request", async ({ payload }) => {
    let result: unknown;
    try {
      const data = await readDesktopMcpTool(payload.name, payload.arguments, currentMcpDependencies());
      result = { content:[{type:"text", text:JSON.stringify(data ?? null)}], structuredContent:{data:data ?? null}, isError:false };
    } catch (error) {
      const text = error instanceof McpInputError ? error.message : "Unable to read Lynse data. Check the desktop app and retry.";
      result = { content:[{type:"text", text}], isError:true };
    }
    // No result or credential logging; a disabled server drops pending responses.
    await invoke("desktop_mcp_complete", { requestId:payload.requestId, result }).catch(() => {});
  });
}
