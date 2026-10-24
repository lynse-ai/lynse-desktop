/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { NavigationProvider, type NavigationAdapter } from "../navigation";
import { workbenchLocales } from "./locales";
import { MemoryPage } from "./page";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string) => workbenchLocales.en[key.replace("workbench.", "") as keyof typeof workbenchLocales.en] ?? key,
  }),
}));
vi.mock("./api", () => ({
  useWikiEnabled: () => true,
  getWorkbenchApi: () => ({}),
  useWorkbench: (selector: (state: unknown) => unknown) => selector({ status: { scope: "account", enabled: true, allowAi: true, automation: {} }, error: null }),
}));
vi.mock("./memory-management", () => ({ MemoryManagementPage: () => <main aria-label="Memory management">Existing shared long-term memory</main> }));
vi.mock("./wiki", () => ({ useWiki: () => ({ busy: false }) }));
vi.mock("./wiki-workspace", () => ({ WikiWorkspace: () => <p>Current meeting knowledge</p> }));
vi.mock("./memory-library", () => ({ MemoryLibrary: () => <p>Existing shared long-term memory</p> }));
vi.mock("./components", () => ({ WorkbenchSettingsContent: () => null }));
vi.mock("../settings/vault-config-card", () => ({ VaultConfigCard: () => <p>Knowledge configuration</p> }));
vi.mock("./progress", () => ({ isWikiProcessingComplete: () => true }));

afterEach(cleanup);

function Harness({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath);
  const url = new URL(path, "https://lynse.test");
  const navigation: NavigationAdapter = { pathname: url.pathname, searchParams: url.searchParams, push: setPath, replace: setPath, back: vi.fn(), getShareableUrl: value => value };
  return <NavigationProvider value={navigation}><MemoryPage /><output aria-label="Current link">{path}</output></NavigationProvider>;
}

describe("existing memory links", () => {
  it.each([
    ["/memory", "Knowledge base", "Current meeting knowledge"],
    ["/memory?tab=wiki", "Knowledge base", "Current meeting knowledge"],
    ["/memory?tab=settings", "Knowledge base settings", "Knowledge configuration"],
    ["/memory?tab=library", "Memory management", "Existing shared long-term memory"],
  ])("opens %s with the existing content", (path, title, content) => {
    render(<Harness initialPath={path} />);
    expect(screen.getByRole("main", { name: title })).toBeTruthy();
    expect(screen.getByText(content).closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("does not mount the legacy file editor behind knowledge browsing", () => {
    render(<Harness initialPath="/memory?tab=wiki" />);
    expect(screen.queryByText("Existing shared long-term memory")).toBeNull();
  });

  it("keeps topic, source and directory parameters through knowledge settings", () => {
    render(<Harness initialPath="/memory?tab=wiki&view=catalog&topic=topic-1&node=wiki%3Atopic-1&source=meeting-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Knowledge base settings" }));
    expect(screen.getByRole("status", { name: "Current link" }).textContent).toContain("tab=settings&view=catalog&topic=topic-1&node=wiki%3Atopic-1&source=meeting-1");
    fireEvent.click(screen.getByRole("button", { name: "Back to knowledge base" }));
    expect(screen.getByRole("status", { name: "Current link" }).textContent).toBe("/memory?tab=wiki&view=catalog&topic=topic-1&node=wiki%3Atopic-1&source=meeting-1");
  });
});
