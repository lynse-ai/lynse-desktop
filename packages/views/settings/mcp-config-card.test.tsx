/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const t = (key: string) => key;
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { McpConfigCard } from "./mcp-config-card";

const getConfig = vi.fn();
const configure = vi.fn();
const writeText = vi.fn();
const config = { enabled:false, port:27125, token:"local-test-credential" };
beforeEach(() => {
  vi.resetAllMocks();
  getConfig.mockResolvedValue(config);
  configure.mockImplementation(async (enabled: boolean, port: number, rotate: boolean) => ({...config, enabled, port, token:rotate ? "rotated-credential" : config.token}));
  Object.defineProperty(window, "desktopAPI", { configurable:true, value:{mcp:{getConfig, configure}} });
  Object.defineProperty(navigator, "clipboard", { configurable:true, value:{writeText} });
});
afterEach(cleanup);

describe("Desktop MCP settings", () => {
  it("keeps MCP off until explicitly enabled and copies valid client configuration", async () => {
    render(<McpConfigCard />);
    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(configure).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await screen.findByRole("button", {name:"mcp.copy_codex"});
    fireEvent.click(screen.getByRole("button", {name:"mcp.copy_codex"}));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const toml = writeText.mock.calls[0]![0] as string;
    expect(toml.split("\n")).toHaveLength(4);
    expect(toml).toContain('url = "http://127.0.0.1:27125/mcp"');
    expect(toml).toContain('Authorization = "Bearer local-test-credential"');
    expect(screen.queryByText(config.token)).toBeNull();
    fireEvent.click(screen.getByRole("button", {name:"mcp.copy_workbuddy"}));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const json = JSON.parse(writeText.mock.calls[1]![0] as string);
    expect(json.mcpServers.lynse_desktop).toEqual({type:"streamableHttp", url:"http://127.0.0.1:27125/mcp", headers:{Authorization:"Bearer local-test-credential"}});
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(configure.mock.calls.map((call) => call[0])).toEqual([true, false]);
  });

  it("does not enable or expose configuration when the native listener cannot start", async () => {
    configure.mockRejectedValue(new Error("Port in use"));
    render(<McpConfigCard />);
    await waitFor(() => expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "mcp.start_failed");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", {name:"mcp.copy_codex"})).toBeNull();
  });

  it("replaces the credential in newly copied configuration after rotation", async () => {
    getConfig.mockResolvedValue({...config, enabled:true});
    render(<McpConfigCard />);
    fireEvent.click(await screen.findByRole("button", {name:"mcp.rotate"}));
    await waitFor(() => expect(configure).toHaveBeenCalledWith(true, 27125, true));
    await waitFor(() => expect(screen.getByRole("button", {name:"mcp.rotate"}).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", {name:"mcp.copy_workbuddy"}));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0]![0]).toContain("rotated-credential");
  });

  it("hides the desktop feature in the web application", () => {
    Object.defineProperty(window, "desktopAPI", { configurable:true, value:undefined });
    const {container} = render(<McpConfigCard />);
    expect(container.childElementCount).toBe(0);
  });
});
