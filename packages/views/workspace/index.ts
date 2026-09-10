export { WorkspaceLayout } from "./workspace-layout";
export { setChatDirectBaseUrl } from "./chat-transport";
export type {
  SttDownloadProgress,
  SttModelInfo,
  SttProviderConfig,
  TranscribeConfig,
} from "./local-transcription";
export {
  buildNoteMarkdown,
  getDesktopVaultApi,
  isHtmlContent,
  removeNotesFromVault,
  syncAllNotesToVault,
  useNoteVaultSync,
  useVaultConfig,
  VAULT_CONFIG_QUERY_KEY,
  VAULT_DEFAULT_SECTION_LABELS,
} from "./note-vault";
export type {
  DesktopVaultApi,
  VaultBatchSummary,
  VaultConfig,
  VaultNotePayload,
  VaultSectionLabels,
  VaultSyncNoteRef,
  VaultSyncProgress,
} from "./note-vault";
