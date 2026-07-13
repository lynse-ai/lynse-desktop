export function isLocalTranscriptionActive({
  statusTag,
  retrying,
}: {
  statusTag?: string;
  retrying: boolean;
}): boolean {
  return retrying || statusTag === "排队中" || statusTag === "转写中";
}
