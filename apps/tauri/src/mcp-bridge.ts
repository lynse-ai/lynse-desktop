import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

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
  await getCurrentWebview().listen<{ requestId:string; name:string; arguments:Record<string, unknown> }>("lynse-mcp-request", async ({ payload }) => {
    let result: unknown;
    const tools = await import("./mcp-data").catch(() => null);
    try {
      if (!tools) throw new Error("MCP data unavailable");
      const data = await tools.readDesktopMcpTool(payload.name, payload.arguments, tools.currentMcpDependencies());
      result = { content:[{type:"text", text:JSON.stringify(data ?? null)}], structuredContent:{data:data ?? null}, isError:false };
    } catch (error) {
      const text = tools && error instanceof tools.McpInputError ? error.message : "Unable to read Lynse data. Check the desktop app and retry.";
      result = { content:[{type:"text", text}], isError:true };
    }
    // No result or credential logging; a disabled server drops pending responses.
    await invoke("desktop_mcp_complete", { requestId:payload.requestId, result }).catch(() => {});
  });
}
