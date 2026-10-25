/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { InspirationCaptureSheet } from "./capture-sheet";
import { InspirationPrivacySupervisor } from "./privacy-supervisor";
import { closePrivacyDialog, useInspirationPrivacy } from "./privacy-state";
import { useInspirationCaptureStore } from "./capture-store";
import { inspirationPrivacyLocales } from "./privacy-locales";

const fixture = vi.hoisted(() => ({ bridge: {} as Record<string, unknown>, locked: () => {} }));
vi.mock("./desktop-api", () => ({ getDesktopInspirationApi: () => fixture.bridge }));
vi.mock("./use-inspiration-cloud", () => ({ useInspirationCloud: () => ({}) }));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("../todo/todo-api", () => ({ saveTodo: vi.fn() }));
vi.mock("../todo/use-todos", () => ({ useTodoStore: { getState: () => ({ upsert: vi.fn() }) } }));
vi.mock("./use-inspiration-voice", () => ({ useInspirationVoice: () => ({ phase: "idle", cancel: vi.fn() }), formatVoiceDuration: () => "0:00" }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key.startsWith("inspiration_private.") ? inspirationPrivacyLocales.en[key.replace("inspiration_private.", "") as keyof typeof inspirationPrivacyLocales.en] ?? key : key }) }));
vi.mock("@lynse/ui/components/ui/sheet", () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div>{children}</div> : null, SheetContent: ({ children }: { children: ReactNode }) => <section>{children}</section> }));
vi.mock("@lynse/ui/components/ui/dialog", () => ({ Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null, DialogContent: ({ children }: { children: ReactNode }) => <section>{children}</section>, DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>, DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>, DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p> }));

let client: QueryClient;
let unlocked = false;
const initialize = vi.fn();
const save = vi.fn();
beforeEach(() => {
  unlocked = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  useInspirationPrivacy.setState({ accountScope: "account-a", generation: 0, binding: false, dialog: null, resolve: null });
  useInspirationCaptureStore.getState().openCapture();
  initialize.mockReset().mockImplementation(async () => { unlocked = true; return { recoveryCode: "synthetic-recovery-code", cloudPending: false }; });
  save.mockReset().mockResolvedValue({ id: "saved" });
  fixture.bridge = { list: vi.fn().mockResolvedValue([]), save, privacy: { status: vi.fn(async () => ({ initialized: unlocked, unlocked, enabled: true })), initialize, confirmRecovery: vi.fn().mockResolvedValue(undefined), onLocked: async (callback: () => void) => { fixture.locked = callback; return () => {}; }, touch: vi.fn(), lock: vi.fn() } };
});
afterEach(() => { cleanup(); closePrivacyDialog(false); useInspirationCaptureStore.getState().closeCapture(); client.clear(); });
function mount() { render(<QueryClientProvider client={client}><InspirationPrivacySupervisor /><InspirationCaptureSheet /></QueryClientProvider>); }

describe("inspiration encryption controls", () => {
  it("places the encryption button immediately to the left of Save", () => {
    mount();
    const lock = screen.getByRole("button", { name: "Encrypt this record" });
    expect(lock.nextElementSibling).toBe(screen.getByRole("button", { name: "inspiration.save" }));
  });
  it("requires a matching encryption password and recovery acknowledgement before the first encrypted save", async () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("inspiration.capture_placeholder"), { target: { value: "private canary" } });
    fireEvent.click(screen.getByRole("button", { name: "Encrypt this record" }));
    await screen.findByLabelText("Encryption password (this device)");
    fireEvent.change(screen.getByLabelText("Encryption password (this device)"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(initialize).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("synthetic-recovery-code");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I saved the recovery code offline" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove encryption and save normally" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "inspiration.save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ protection: "e2ee", text: "private canary" })));
  });
  it("does not request an encryption password before the server enables private storage", async () => {
    fixture.bridge = {...fixture.bridge, privacy:{...(fixture.bridge.privacy as object),status:async()=>({initialized:false,unlocked:false,enabled:false})}};
    mount();
    await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Encrypt this record"})));
    expect(screen.queryByLabelText("Encryption password (this device)")).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });
  it("does not carry an unsaved ordinary draft into another account", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText("inspiration.capture_placeholder"), {target:{value:"account A draft"}});
    act(() => useInspirationPrivacy.setState({accountScope:"account-b"}));
    expect((screen.getByPlaceholderText("inspiration.capture_placeholder") as HTMLTextAreaElement).value).toBe("");
  });
  it("clears displayed recovery material and protected query caches on a native lock", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Encrypt this record" }));
    await screen.findByLabelText("Encryption password (this device)");
    fireEvent.change(screen.getByLabelText("Encryption password (this device)"), { target: { value: "long-password" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("synthetic-recovery-code");
    client.setQueryData(["inspiration-detail", "account-a", "id", 0], { text: "protected cache canary" });
    act(() => fixture.locked());
    expect(screen.queryByText("synthetic-recovery-code")).toBeNull();
    expect(client.getQueryData(["inspiration-detail", "account-a", "id", 0])).toBeUndefined();
    expect(JSON.stringify(client.getQueriesData({queryKey:["inspiration-detail"]}))).not.toContain("protected cache canary");
  });
});
