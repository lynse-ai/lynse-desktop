import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("recording source icons follow confirmed capture state and show the diagonal only when off", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const host = window as unknown as {
      __LYNSE_E2E__: { setCommand: (name: string, handler: (args: any) => any) => void; emit: (name: string, payload: unknown) => void };
      desktopAPI: { liveTranslation: { getProviderConfig: () => Promise<unknown> } };
    };
    let snapshot = { state: "recording", sessionId: "source-test", epoch: 0, elapsedMs: 12000,
      micLevel: 0.3, systemLevel: 0.7, recordingLevel: 0.8, sourceRevision: 1,
      audioSources: ["mic", "system"], sourceErrors: {}, segments: [], sourceLanguage: "zh", targetLanguage: "zh" };
    host.desktopAPI.liveTranslation.getProviderConfig = async () => ({ activeProvider: "lynse_backend", audioSource: "both", values: {} });
    host.__LYNSE_E2E__.setCommand("live_translation_permissions", () => ({ microphone: "granted", systemAudio: "granted", microphoneAvailable: true, systemAudioAvailable: true, systemAudioRequired: true, restartRequired: false }));
    host.__LYNSE_E2E__.setCommand("live_translation_state", () => snapshot);
    host.__LYNSE_E2E__.setCommand("live_translation_set_sources", async ({ request }) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      snapshot = { ...snapshot, audioSources: request.audioSources, sourceRevision: snapshot.sourceRevision + 1 };
      host.__LYNSE_E2E__.emit("live-translation-event", { type: "state", snapshot });
      return snapshot;
    });
    window.dispatchEvent(new Event("lynse:live-translation-tray-action"));
  });
  const microphone = page.getByRole("switch", { name: /^Microphone/ });
  const computer = page.getByRole("switch", { name: /^Computer audio/ });
  await expect(microphone).toBeChecked();
  await expect(computer).toBeChecked();
  await microphone.click();
  await expect(microphone).toHaveAttribute("aria-busy", "true");
  await expect(microphone).toBeChecked();
  await expect(microphone).not.toBeChecked();
  await expect(microphone.locator('path[d="M3 21 21 3"]')).toHaveCount(2);
  await expect(computer).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("computer-only.png"), animations: "disabled" });
  await microphone.click();
  await expect(microphone).toBeChecked();
  await expect(microphone.locator('path[d="M3 21 21 3"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__LYNSE_E2E__.emit("live-translation-event", {
    type: "levels", sessionId: "source-test", sourceRevision: 3, mic: 0.3, system: 0.7,
    recordingLevel: 0.8, elapsedMs: 13000, aecDegraded: true,
  }));
  await expect(page.getByRole("status").filter({ hasText: "Echo cancellation unavailable" })).toBeVisible();
});

test("missing microphone is visible while computer audio remains enabled", async ({ page, mockServer }) => {
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const host = window as any;
    host.desktopAPI.liveTranslation.getProviderConfig = async () => ({ activeProvider: "lynse_backend", audioSource: "both", values: {} });
    host.__LYNSE_E2E__.setCommand("live_translation_permissions", () => ({ microphone: "denied", systemAudio: "granted", microphoneAvailable: false, systemAudioAvailable: true, systemAudioRequired: true, restartRequired: false }));
    host.__LYNSE_E2E__.setCommand("live_translation_state", () => ({ state: "recording", sessionId: "no-mic-test", epoch: 0, elapsedMs: 12000,
      micLevel: 0, systemLevel: 0.7, recordingLevel: 0.7, sourceRevision: 1, audioSources: ["system"], sourceErrors: { mic: "no_device" }, segments: [] }));
    window.dispatchEvent(new Event("lynse:live-translation-tray-action"));
  });
  await expect(page.getByRole("switch", { name: /^Computer audio/ })).toBeChecked();
  await expect(page.getByRole("switch", { name: /^Microphone/ })).not.toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "No device detected" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("missing-microphone.png"), animations: "disabled" });
});
