import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { App, BrowserWindow, IpcMain, OpenDialogOptions } from "electron";
import { dialog, protocol } from "electron";

export interface LocalTranscriptionSegment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  speakerId?: string;
  speakerName?: string;
  rawSpeaker?: string;
  confidence?: number;
  voiceprintId?: string;
  /** @deprecated compatibility with first local-transcription records */
  speaker?: string;
}

export type LocalTranscriptionStatus = "queued" | "transcribing" | "completed" | "failed";
export type LocalTranscriptionProgressPhase = LocalTranscriptionStatus;

export interface LocalTranscriptionRecord {
  id: string;
  title: string;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  transcriptText: string;
  status: LocalTranscriptionStatus;
  progressPhase?: LocalTranscriptionProgressPhase;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  engine: "funasr";
  segments: LocalTranscriptionSegment[];
  error?: string;
}

export interface LocalTranscriptionOptions {
  expectedSpeakers?: number;
  hotwordPackageId?: string;
}

export interface LocalHotwordTerm {
  term: string;
  replacement?: string;
  enabled: boolean;
  weight?: number;
}

export interface LocalHotwordPackage {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  terms: LocalHotwordTerm[];
}

export interface LocalVoiceprint {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sampleRecordId: string;
  sampleSegmentIds: string[];
  embedding: number[];
  sampleText?: string;
}

export interface NormalizedFunasrOutput {
  text: string;
  segments: LocalTranscriptionSegment[];
}

export interface LocalAsrModelStatus {
  status: "not_installed" | "installed" | "downloading";
  modelDir: string;
  modelName: string;
}

type FunasrSentence = {
  text?: unknown;
  sentence?: unknown;
  start?: unknown;
  end?: unknown;
  spk?: unknown;
  speaker?: unknown;
  speaker_name?: unknown;
  speakerName?: unknown;
  confidence?: unknown;
  score?: unknown;
  voiceprint_id?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanTranscriptText(text: string): string {
  return text
    .replace(/<\|[^|>]+\|>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpeakerRaw(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function speakerNameFromRaw(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) return `发言人${numeric + 1}`;
  return `发言人${raw}`;
}

function speakerIdFromRaw(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) return `spk-${numeric + 1}`;
  return `spk-${raw}`;
}

export function normalizeFunasrOutput(raw: unknown): NormalizedFunasrOutput {
  const root = Array.isArray(raw) ? asRecord(raw[0]) : asRecord(raw);
  const sentenceInfo = Array.isArray(root.sentence_info)
    ? root.sentence_info as FunasrSentence[]
    : [];

  const segments: LocalTranscriptionSegment[] = [];
  sentenceInfo.forEach((sentence, index) => {
      const text = cleanTranscriptText(asText(sentence.sentence) || asText(sentence.text));
      if (!text) return;
      const rawSpeaker = normalizeSpeakerRaw(sentence.spk ?? sentence.speaker);
      const speakerName = asText(sentence.speakerName) || asText(sentence.speaker_name) || speakerNameFromRaw(rawSpeaker);
      const confidence = asNumber(sentence.confidence) ?? asNumber(sentence.score);
      segments.push({
        id: `seg-${index + 1}`,
        text,
        startMs: asNumber(sentence.start),
        endMs: asNumber(sentence.end),
        speakerId: speakerIdFromRaw(rawSpeaker),
        speakerName,
        rawSpeaker,
        confidence,
        voiceprintId: asText(sentence.voiceprint_id) || undefined,
      });
    });

  const text = cleanTranscriptText(asText(root.text)) || segments.map((segment) => segment.text).join("");
  return { text, segments };
}

export function parseFunasrJsonFromStdout(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") || line.startsWith("["));
  if (!jsonLine) throw new Error("FunASR did not return JSON output");
  return JSON.parse(jsonLine);
}

export function createCompletedLocalRecord({
  sourcePath,
  transcriptText,
  segments,
  expectedSpeakers,
  hotwordPackageId,
  now = new Date().toISOString(),
  randomId = randomUUID,
}: {
  sourcePath: string;
  transcriptText: string;
  segments: LocalTranscriptionSegment[];
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  now?: string;
  randomId?: () => string;
}): LocalTranscriptionRecord {
  return {
    id: `local:${randomId()}`,
    title: basename(sourcePath),
    sourcePath,
    createdAt: now,
    updatedAt: now,
    transcriptText,
    status: "completed",
    progressPhase: "completed",
    completedAt: now,
    expectedSpeakers,
    hotwordPackageId,
    engine: "funasr",
    segments,
  };
}

export function createQueuedLocalRecord({
  sourcePath,
  expectedSpeakers,
  hotwordPackageId,
  now = new Date().toISOString(),
  randomId = randomUUID,
}: {
  sourcePath: string;
  expectedSpeakers?: number;
  hotwordPackageId?: string;
  now?: string;
  randomId?: () => string;
}): LocalTranscriptionRecord {
  return {
    id: `local:${randomId()}`,
    title: basename(sourcePath),
    sourcePath,
    createdAt: now,
    updatedAt: now,
    transcriptText: "",
    status: "queued",
    progressPhase: "queued",
    expectedSpeakers,
    hotwordPackageId,
    engine: "funasr",
    segments: [],
  };
}

export class LocalTranscriptionStore {
  private readonly indexPath: string;

  constructor(private readonly userDataPath: string) {
    this.indexPath = join(userDataPath, "local-transcriptions", "index.json");
  }

  async list(): Promise<LocalTranscriptionRecord[]> {
    const records = await this.readAll();
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<LocalTranscriptionRecord | null> {
    const records = await this.readAll();
    return records.find((record) => record.id === id) ?? null;
  }

  async save(record: LocalTranscriptionRecord): Promise<void> {
    const records = await this.readAll();
    const next = [
      record,
      ...records.filter((item) => item.id !== record.id),
    ];
    await mkdir(join(this.userDataPath, "local-transcriptions"), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(next, null, 2), "utf8");
  }

  async update(id: string, patch: Partial<LocalTranscriptionRecord>): Promise<LocalTranscriptionRecord | null> {
    const records = await this.readAll();
    let updated: LocalTranscriptionRecord | null = null;
    const next = records.map((record) => {
      if (record.id !== id) return record;
      updated = { ...record, ...patch };
      return updated;
    });
    if (!updated) return null;
    await mkdir(join(this.userDataPath, "local-transcriptions"), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(next, null, 2), "utf8");
    return updated;
  }

  async remove(id: string): Promise<void> {
    const records = await this.readAll();
    await mkdir(join(this.userDataPath, "local-transcriptions"), { recursive: true });
    await writeFile(
      this.indexPath,
      JSON.stringify(records.filter((record) => record.id !== id), null, 2),
      "utf8",
    );
  }

  private async readAll(): Promise<LocalTranscriptionRecord[]> {
    try {
      const content = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed as LocalTranscriptionRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

class JsonArrayStore<T extends { id: string }> {
  constructor(
    private readonly dirPath: string,
    private readonly indexPath: string,
  ) {}

  async list(): Promise<T[]> {
    return this.readAll();
  }

  async get(id: string): Promise<T | null> {
    const items = await this.readAll();
    return items.find((item) => item.id === id) ?? null;
  }

  async save(item: T): Promise<void> {
    const items = await this.readAll();
    const next = [item, ...items.filter((existing) => existing.id !== item.id)];
    await mkdir(this.dirPath, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(next, null, 2), "utf8");
  }

  async remove(id: string): Promise<void> {
    const items = await this.readAll();
    await mkdir(this.dirPath, { recursive: true });
    await writeFile(
      this.indexPath,
      JSON.stringify(items.filter((item) => item.id !== id), null, 2),
      "utf8",
    );
  }

  private async readAll(): Promise<T[]> {
    try {
      const content = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export class LocalHotwordPackageStore extends JsonArrayStore<LocalHotwordPackage> {
  constructor(userDataPath: string) {
    super(
      join(userDataPath, "local-hotwords"),
      join(userDataPath, "local-hotwords", "index.json"),
    );
  }
}

export class LocalVoiceprintStore extends JsonArrayStore<LocalVoiceprint> {
  constructor(userDataPath: string) {
    super(
      join(userDataPath, "local-voiceprints"),
      join(userDataPath, "local-voiceprints", "index.json"),
    );
  }
}

export function buildHotwordText(pkg: LocalHotwordPackage | null | undefined): string {
  if (!pkg?.enabled) return "";
  return pkg.terms
    .filter((term) => term.enabled && term.term.trim())
    .map((term) => term.term.trim())
    .join(" ");
}

export function applyHotwordReplacements(text: string, terms: LocalHotwordTerm[]): string {
  return terms.reduce((current, term) => {
    if (!term.enabled || !term.term.trim() || !term.replacement?.trim()) return current;
    return current.split(term.term).join(term.replacement);
  }, text);
}

function localAsrModelDir(userDataPath: string): string {
  return join(userDataPath, "local-asr-models", "funasr");
}

function localAsrReadyMarker(userDataPath: string): string {
  return join(localAsrModelDir(userDataPath), ".ready");
}

export async function getLocalAsrModelStatus(
  userDataPath: string,
  downloading = false,
): Promise<LocalAsrModelStatus> {
  if (downloading) {
    return {
      status: "downloading",
      modelDir: localAsrModelDir(userDataPath),
      modelName: "FunASR Paraformer + VAD + PUNC + CAM++",
    };
  }
  try {
    await access(localAsrReadyMarker(userDataPath));
    return {
      status: "installed",
      modelDir: localAsrModelDir(userDataPath),
      modelName: "FunASR Paraformer + VAD + PUNC + CAM++",
    };
  } catch {
    return {
      status: "not_installed",
      modelDir: localAsrModelDir(userDataPath),
      modelName: "FunASR Paraformer + VAD + PUNC + CAM++",
    };
  }
}

export async function deleteLocalAsrModel(userDataPath: string): Promise<LocalAsrModelStatus> {
  await rm(localAsrModelDir(userDataPath), { recursive: true, force: true });
  return getLocalAsrModelStatus(userDataPath);
}

export function buildFunasrScriptArgs({
  mode,
  scriptPath,
  modelDir,
  audioPath,
  expectedSpeakers,
  hotwordText,
}: {
  mode: "download" | "transcribe";
  scriptPath: string;
  modelDir: string;
  audioPath?: string;
  expectedSpeakers?: number;
  hotwordText?: string;
}): string[] {
  if (mode === "download") {
    return [scriptPath, "--download-models", "--model-dir", modelDir];
  }
  if (!audioPath) throw new Error("audioPath is required for transcription");
  const args = [scriptPath, audioPath, "--model-dir", modelDir];
  if (expectedSpeakers && expectedSpeakers > 0) {
    args.push("--expected-speakers", String(expectedSpeakers));
  }
  if (hotwordText?.trim()) {
    args.push("--hotword", hotwordText.trim());
  }
  return args;
}

function runFunasrScript({
  args,
  modelDir,
  pythonCommand = process.env.LYNSE_FUNASR_PYTHON || "python3",
}: {
  args: string[];
  modelDir: string;
  pythonCommand?: string;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonCommand, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MODELSCOPE_CACHE: modelDir,
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString("utf8"));
        return;
      }
      reject(new Error(Buffer.concat(err).toString("utf8") || `FunASR exited with code ${code}`));
    });
  });
}

export async function downloadLocalAsrModel({
  userDataPath,
  scriptPath,
}: {
  userDataPath: string;
  scriptPath: string;
}): Promise<LocalAsrModelStatus> {
  const modelDir = localAsrModelDir(userDataPath);
  await mkdir(modelDir, { recursive: true });
  await runFunasrScript({
    args: buildFunasrScriptArgs({
      mode: "download",
      scriptPath,
      modelDir,
    }),
    modelDir,
  });
  return getLocalAsrModelStatus(userDataPath);
}

export async function runFunasrTranscription({
  audioPath,
  scriptPath,
  modelDir,
  expectedSpeakers,
  hotwordText,
  pythonCommand = process.env.LYNSE_FUNASR_PYTHON || "python3",
}: {
  audioPath: string;
  scriptPath: string;
  modelDir: string;
  expectedSpeakers?: number;
  hotwordText?: string;
  pythonCommand?: string;
}): Promise<NormalizedFunasrOutput> {
  const stdout = await runFunasrScript({
    args: buildFunasrScriptArgs({
      mode: "transcribe",
      scriptPath,
      audioPath,
      modelDir,
      expectedSpeakers,
      hotwordText,
    }),
    modelDir,
    pythonCommand,
  });

  return normalizeFunasrOutput(parseFunasrJsonFromStdout(stdout));
}

export async function getLocalMediaUrlForRecord(
  store: LocalTranscriptionStore,
  id: string,
): Promise<string | null> {
  const record = await store.get(id);
  return record ? `local-media://${encodeURIComponent(record.id)}` : null;
}

function registerLocalMediaProtocol(store: LocalTranscriptionStore): void {
  if (protocol.isProtocolHandled("local-media")) return;
  protocol.registerFileProtocol("local-media", async (request, callback) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.hostname || url.pathname.replace(/^\//, ""));
      const record = await store.get(id);
      if (!record?.sourcePath) {
        callback({ error: -6 });
        return;
      }
      callback({ path: record.sourcePath });
    } catch {
      callback({ error: -2 });
    }
  });
}

async function processLocalTranscriptionRecord({
  record,
  store,
  hotwordStore,
  scriptPath,
  modelDir,
}: {
  record: LocalTranscriptionRecord;
  store: LocalTranscriptionStore;
  hotwordStore: LocalHotwordPackageStore;
  scriptPath: string;
  modelDir: string;
}): Promise<LocalTranscriptionRecord> {
  const startedAt = new Date().toISOString();
  await store.update(record.id, {
    status: "transcribing",
    progressPhase: "transcribing",
    startedAt,
    updatedAt: startedAt,
    error: undefined,
  });
  try {
    const hotwordPackage = record.hotwordPackageId ? await hotwordStore.get(record.hotwordPackageId) : null;
    const output = await runFunasrTranscription({
      audioPath: record.sourcePath,
      scriptPath,
      modelDir,
      expectedSpeakers: record.expectedSpeakers,
      hotwordText: buildHotwordText(hotwordPackage),
    });
    const terms = hotwordPackage?.terms ?? [];
    const transcriptText = applyHotwordReplacements(output.text, terms);
    const segments = output.segments.map((segment) => ({
      ...segment,
      text: applyHotwordReplacements(segment.text, terms),
    }));
    const completedAt = new Date().toISOString();
    const completed = await store.update(record.id, {
      transcriptText,
      segments,
      status: "completed",
      progressPhase: "completed",
      completedAt,
      updatedAt: completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      error: undefined,
    });
    if (!completed) throw new Error("Local transcription record disappeared");
    return completed;
  } catch (error) {
    const failedAt = new Date().toISOString();
    await store.update(record.id, {
      status: "failed",
      progressPhase: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: failedAt,
      completedAt: failedAt,
    });
    throw error;
  }
}

function defaultScriptPath(app: App): string {
  if (app.isPackaged) return join(process.resourcesPath, "funasr_transcribe.py");
  return join(app.getAppPath(), "resources", "funasr_transcribe.py");
}

export function registerLocalTranscriptionIpc({
  app,
  ipcMain,
  getMainWindow,
}: {
  app: App;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const store = new LocalTranscriptionStore(app.getPath("userData"));
  const hotwordStore = new LocalHotwordPackageStore(app.getPath("userData"));
  const voiceprintStore = new LocalVoiceprintStore(app.getPath("userData"));
  let modelDownload: Promise<LocalAsrModelStatus> | null = null;
  registerLocalMediaProtocol(store);

  ipcMain.handle("local-transcription:list", () => store.list());
  ipcMain.handle("local-transcription:get", (_event, id: string) => store.get(id));
  ipcMain.handle("local-transcription:delete", (_event, id: string) => store.remove(id));
  ipcMain.handle("local-transcription:getAudioUrl", (_event, id: string) =>
    getLocalMediaUrlForRecord(store, id),
  );
  ipcMain.handle("local-transcription:getModelStatus", () =>
    getLocalAsrModelStatus(app.getPath("userData"), !!modelDownload),
  );
  ipcMain.handle("local-transcription:downloadModel", async () => {
    if (!modelDownload) {
      modelDownload = downloadLocalAsrModel({
        userDataPath: app.getPath("userData"),
        scriptPath: defaultScriptPath(app),
      }).finally(() => {
        modelDownload = null;
      });
    }
    return modelDownload;
  });
  ipcMain.handle("local-transcription:deleteModel", () => {
    if (modelDownload) throw new Error("Cannot delete while model is downloading");
    return deleteLocalAsrModel(app.getPath("userData"));
  });
  ipcMain.handle("local-transcription:pickAudioFile", async () => {
    const options: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        {
          name: "Audio and video",
          extensions: ["mp3", "wav", "m4a", "mp4", "flac", "aac", "ogg", "webm", "mov"],
        },
      ],
    };
    const window = getMainWindow();
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("local-transcription:transcribe", async (_event, audioPath: string, options?: LocalTranscriptionOptions) => {
    const modelStatus = await getLocalAsrModelStatus(app.getPath("userData"), !!modelDownload);
    if (modelStatus.status !== "installed") {
      throw new Error("Local ASR model is not installed");
    }
    const record = createQueuedLocalRecord({
      sourcePath: audioPath,
      expectedSpeakers: options?.expectedSpeakers,
      hotwordPackageId: options?.hotwordPackageId,
    });
    await store.save(record);
    return processLocalTranscriptionRecord({
      record,
      store,
      hotwordStore,
      scriptPath: defaultScriptPath(app),
      modelDir: modelStatus.modelDir,
    });
  });
  ipcMain.handle("local-transcription:retry", async (_event, id: string) => {
    const modelStatus = await getLocalAsrModelStatus(app.getPath("userData"), !!modelDownload);
    if (modelStatus.status !== "installed") {
      throw new Error("Local ASR model is not installed");
    }
    const record = await store.get(id);
    if (!record) throw new Error("Local transcription not found");
    return processLocalTranscriptionRecord({
      record: {
        ...record,
        transcriptText: "",
        segments: [],
        status: "queued",
        progressPhase: "queued",
        error: undefined,
      },
      store,
      hotwordStore,
      scriptPath: defaultScriptPath(app),
      modelDir: modelStatus.modelDir,
    });
  });
  ipcMain.handle("local-transcription:listHotwordPackages", () => hotwordStore.list());
  ipcMain.handle("local-transcription:saveHotwordPackage", (_event, pkg: LocalHotwordPackage) =>
    hotwordStore.save(pkg).then(() => pkg),
  );
  ipcMain.handle("local-transcription:deleteHotwordPackage", (_event, id: string) => hotwordStore.remove(id));
  ipcMain.handle("local-transcription:listVoiceprints", () => voiceprintStore.list());
  ipcMain.handle("local-transcription:createVoiceprint", async (_event, input: {
    name: string;
    sampleRecordId: string;
    sampleSegmentIds: string[];
  }) => {
    const record = await store.get(input.sampleRecordId);
    if (!record) throw new Error("Local transcription not found");
    const sampleSegments = record.segments.filter((segment) => input.sampleSegmentIds.includes(segment.id));
    const now = new Date().toISOString();
    const voiceprint: LocalVoiceprint = {
      id: `voiceprint:${randomUUID()}`,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      sampleRecordId: input.sampleRecordId,
      sampleSegmentIds: input.sampleSegmentIds,
      embedding: sampleSegments.map((segment) => segment.text.length),
      sampleText: sampleSegments.map((segment) => segment.text).join("\n"),
    };
    await voiceprintStore.save(voiceprint);
    return voiceprint;
  });
  ipcMain.handle("local-transcription:updateVoiceprint", (_event, voiceprint: LocalVoiceprint) =>
    voiceprintStore.save({ ...voiceprint, updatedAt: new Date().toISOString() }).then(() => voiceprint),
  );
  ipcMain.handle("local-transcription:deleteVoiceprint", (_event, id: string) => voiceprintStore.remove(id));
}
