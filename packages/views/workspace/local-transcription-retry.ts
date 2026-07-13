import type { DesktopLocalTranscriptionApi } from "./local-transcription";

export async function retryLocalTranscription({
  fileId,
  api,
  refresh,
  setRetrying,
  setError,
}: {
  fileId: string | null;
  api: DesktopLocalTranscriptionApi | null;
  refresh: (fileId: string) => void;
  setRetrying: (fileId: string, retrying: boolean) => void;
  setError: (message: string | null) => void;
}): Promise<void> {
  if (!fileId || !api) return;
  setError(null);
  setRetrying(fileId, true);
  refresh(fileId);
  try {
    await api.retry(fileId);
    refresh(fileId);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    refresh(fileId);
  } finally {
    setRetrying(fileId, false);
  }
}
