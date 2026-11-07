import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

function testWave(): Buffer {
  const dataSize = 16_000;
  const wave = Buffer.alloc(44 + dataSize);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16_000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(dataSize, 40);
  return wave;
}

interface TestRuntime {
  __LYNSE_E2E__: { setCommand: (name: string, handle: (args: Record<string, unknown>) => unknown) => void };
  __TAURI_INTERNALS__: { convertFileSrc: (id: string, protocol: string) => string };
  audioTest: {
    attempts: number;
    analyses: number;
    report: (receivedBytes: number, totalBytes: number) => void;
    finish: (success: boolean) => void;
    finishWaveform: () => void;
    finishEditorAnalysis: () => void;
  };
}

test("cloud audio downloads in the player, reuses its local copy and rebuilds the editor waveform", async ({ page, mockServer }) => {
  const signedUrl = `${mockServer.url}/fixture-oss/audio.m4a?signature=synthetic`;
  mockServer.setJsonRoute("/api/business/file/presign/download", signedUrl);
  await page.route("**/cloud-audio-fixture.wav", route => route.fulfill({ contentType: "audio/wav", body: testWave() }));
  await openWorkspace(page, mockServer.url);
  await page.evaluate(() => {
    const runtime = window as unknown as TestRuntime;
    const hooks = runtime.__LYNSE_E2E__;
    const id = "cloud-audio:fixture.m4a";
    const originalConvert = runtime.__TAURI_INTERNALS__.convertFileSrc;
    runtime.__TAURI_INTERNALS__.convertFileSrc = (name, protocol) => name === id
      ? `${location.origin}/cloud-audio-fixture.wav`
      : originalConvert(name, protocol);
    const saved = new Set<string>();
    let waveformReady = false;
    runtime.audioTest = {
      attempts: 0,
      analyses: 0,
      report: () => undefined,
      finish: () => undefined,
      finishWaveform: () => undefined,
      finishEditorAnalysis: () => undefined,
    };
    hooks.setCommand("cloud_audio_get", ({ key }) => saved.has(JSON.stringify(key)) ? id : null);
    hooks.setCommand("cloud_audio_download", ({ key, onProgress }) => {
      runtime.audioTest.attempts++;
      const channel = onProgress as { onmessage: (progress: { receivedBytes: number; totalBytes: number | null }) => void };
      runtime.audioTest.report = (receivedBytes, totalBytes) => channel.onmessage({ receivedBytes, totalBytes });
      if (runtime.audioTest.attempts === 1) {
        channel.onmessage({ receivedBytes: 0, totalBytes: null });
      } else {
        runtime.audioTest.report(320, 800);
      }
      return new Promise((resolve, reject) => {
        runtime.audioTest.finish = success => {
          if (!success) {
            reject(new Error("Synthetic network interruption"));
            return;
          }
          saved.add(JSON.stringify(key));
          resolve(id);
        };
      });
    });
    hooks.setCommand("local_audio_waveform", () => {
      const waveform = { durationMs: 1000, peaks: [0, 0.4, 0.8, 0] };
      if (waveformReady) return waveform;
      return new Promise(resolve => {
        runtime.audioTest.finishWaveform = () => {
          waveformReady = true;
          resolve(waveform);
        };
      });
    });
    hooks.setCommand("audio_editor_status", () => ({ ffmpegAvailable: true }));
    hooks.setCommand("cloud_audio_analyze", () => {
      runtime.audioTest.analyses++;
      const analysis = { durationSec: 1, peaks: [0, 0.4, 0.8, 0], silenceSegments: [] };
      if (runtime.audioTest.analyses > 1) return analysis;
      return new Promise(resolve => {
        runtime.audioTest.finishEditorAnalysis = () => resolve(analysis);
      });
    });
  });

  await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
  const first = page.getByRole("button", { name: /Q3 review\.m4a/ });
  await first.click();
  await page.getByRole("button", { name: "Transcription", exact: true }).click();
  const download = page.getByRole("button", { name: "Download audio", exact: true });
  const edit = page.getByRole("button", { name: "Edit audio", exact: true });
  const play = page.getByRole("button", { name: "Play", exact: true });
  const progress = page.getByRole("progressbar", { name: "Downloading audio…" });
  const waveform = page.getByRole("slider");
  const waveformLoading = page.locator('[data-slot="waveform-loading"]');
  const placeholder = page.locator('[data-slot="audio-download-waveform"]');
  const fill = placeholder.locator('[data-slot="audio-download-fill"]');
  const revealEnd = () => fill.evaluate(element => {
    const track = element.parentElement!.getBoundingClientRect();
    return (element.getBoundingClientRect().right - track.left) / track.width;
  });
  await expect(download).toBeEnabled();
  await expect(placeholder).toBeVisible();
  await expect(placeholder.locator("canvas")).toHaveCount(2);
  await expect.poll(revealEnd).toBeCloseTo(0, 2);
  const waveformHeight = (await placeholder.boundingBox())!.height;
  await expect(play).toHaveCount(0);
  await expect(edit).toHaveCount(0);
  await expect(progress).toHaveCount(0);
  await expect(waveform).toHaveCount(0);
  await expect(waveformLoading).toHaveCount(0);
  expect(mockServer.requests({ path: "/api/business/file/presign/download" })).toHaveLength(0);

  await download.click();
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("aria-valuenow", /.+/);
  await expect.poll(revealEnd).toBeCloseTo(0, 2);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestRuntime).audioTest.attempts)).toBe(1);
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.report(320, 800));
  await expect(progress).toHaveAttribute("aria-valuenow", "40");
  await expect(waveformLoading).toHaveCount(0);
  await expect(fill).toHaveCSS("mask-image", /^linear-gradient/);
  await expect(fill).toHaveCSS("transition-duration", "0.15s");
  await expect.poll(revealEnd).toBeCloseTo(0.4, 1);
  await expect(edit).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("cloud-audio-downloading.png"), animations: "disabled" });
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.report(600, 800));
  await expect(progress).toHaveAttribute("aria-valuenow", "75");
  await expect.poll(revealEnd).toBeGreaterThan(0.75);
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.finish(false));
  await expect(page.getByRole("status").filter({ hasText: "Audio download failed" })).toBeVisible();
  await expect(download).toBeEnabled();
  await expect.poll(revealEnd).toBeCloseTo(0, 2);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await download.click();
  await expect(progress).toHaveAttribute("aria-valuenow", "40");
  await expect(fill).toHaveCSS("transition-property", "none");
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.report(800, 800));
  await expect(progress).toHaveAttribute("aria-valuenow", "99");
  await expect(play).toHaveCount(0);
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.finish(true));
  await expect(play).toBeEnabled();
  await expect(edit).toBeEnabled();
  await expect(download).toHaveCount(0);
  await expect(placeholder).toBeVisible();
  await expect(fill).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  const generating = page.getByRole("status").filter({ hasText: "Generating waveform…" });
  const highlight = waveformLoading.locator(".waveform-loading-highlight");
  await expect(generating).toBeVisible();
  await expect(waveform.locator('[data-slot="waveform-loading"]')).toHaveCount(1);
  await expect(waveformLoading).toBeHidden();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(waveformLoading).toBeVisible();
  await expect(highlight).toHaveCSS("mask-image", /^linear-gradient/);
  await expect(highlight).toHaveCSS("animation-name", "waveform-highlight-sweep");
  await expect.poll(() => highlight.evaluate(element => element.getAnimations()[0]?.playState)).toBe("running");
  await waveformLoading.evaluate(element => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = Number(animation.effect?.getTiming().duration) / 2;
    }
  });
  await waveform.screenshot({ path: test.info().outputPath("cloud-audio-generating-waveform.png") });
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.finishWaveform());
  await expect(waveformLoading).toHaveCount(0);
  await expect(generating).toHaveCount(0);
  await expect(placeholder).toHaveCount(0);
  await expect(waveform.locator("canvas")).toBeVisible();
  expect((await waveform.boundingBox())!.height).toBe(waveformHeight);
  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /project kickoff\.mp3/ }).click();
  await expect(download).toBeEnabled();
  await first.click();
  await expect(edit).toBeVisible();
  const editorWaveform = page.getByLabel("audio editor waveform");
  const editorOverview = page.getByLabel("audio editor overview");
  const editorPlaceholder = page.locator('[data-slot="editor-waveform-placeholder"]');
  const analyzing = page.getByRole("status").filter({ hasText: "Analyzing audio…" });
  await edit.click();
  await expect(analyzing).toBeVisible();
  await expect(editorPlaceholder).toBeVisible();
  await expect(editorWaveform).toHaveCount(0);
  const editorWaveformHeight = await editorPlaceholder.evaluate(element => element.clientHeight);
  await expect.poll(() => page.evaluate(() => (window as unknown as TestRuntime).audioTest.analyses)).toBe(1);
  await page.evaluate(() => (window as unknown as TestRuntime).audioTest.finishEditorAnalysis());
  await expect(editorWaveform).toBeVisible();
  await expect(editorOverview).toBeVisible();
  await expect(editorPlaceholder).toHaveCount(0);
  await expect(analyzing).toHaveCount(0);
  expect(await editorWaveform.evaluate(element => element.clientHeight)).toBe(editorWaveformHeight);
  await expect(page.getByRole("button", { name: "Overwrite original", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to notes", exact: true }).click();
  await edit.click();
  await expect(editorWaveform).toBeVisible();
  expect(await page.evaluate(() => {
    const { attempts, analyses } = (window as unknown as TestRuntime).audioTest;
    return { attempts, analyses };
  })).toEqual({ attempts: 2, analyses: 2 });
  expect(mockServer.requests({ path: "/api/business/file/presign/download" })).toHaveLength(2);
});
