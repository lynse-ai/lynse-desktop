/** Audio MIME for an upload, derived from the artifact's extension. Local
 *  recordings default to M4A (the save pipeline compresses the mixdown);
 *  WAV covers older saves and the no-ffmpeg fallback. `audio/mp4` is the
 *  registered type for AAC-in-M4A and is accepted everywhere the picker's
 *  `audio/m4a` variant is. */
export function audioContentType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "m4a" || extension === "mp4" || extension === "mp4a") return "audio/mp4";
  if (extension === "aac") return "audio/aac";
  if (extension === "mp3" || extension === "mpeg") return "audio/mpeg";
  if (extension === "ogg" || extension === "oga") return "audio/ogg";
  if (extension === "flac") return "audio/flac";
  return "audio/wav";
}
