"use client";
import { create } from "zustand";
import { getDesktopInspirationApi } from "./desktop-api";
export type PrivacyDialogMode = "setup" | "unlock" | "manage" | "recover" | "pair" | "approve" | "finish" | "password" | "rotate";
type PrivacyState = {
  accountScope: string; binding: boolean; generation: number;
  dialog: PrivacyDialogMode | null;
  resolve: ((accepted: boolean) => void) | null;
};
export const useInspirationPrivacy = create<PrivacyState>(() => ({ accountScope: "unbound", binding: false, generation: 0, dialog: null, resolve: null }));
export function closePrivacyDialog(accepted: boolean) {
  const resolve = useInspirationPrivacy.getState().resolve;
  useInspirationPrivacy.setState({ dialog: null, resolve: null });
  resolve?.(accepted);
}
export function openPrivacyDialog(mode: PrivacyDialogMode) {
  if (useInspirationPrivacy.getState().dialog) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => useInspirationPrivacy.setState({ dialog: mode, resolve }));
}
export async function ensureInspirationUnlocked() {
  const privacy = getDesktopInspirationApi()?.privacy;
  if (!privacy) throw new Error("private_storage_unavailable");
  const status = await privacy.status();
  if (!status.enabled && !status.initialized) throw new Error("private_storage_unavailable");
  if (status.unlocked && status.initialized && status.recoveryConfirmed === false) return openPrivacyDialog("rotate");
  if (status.unlocked && status.initialized) return true;
  const accepted = await openPrivacyDialog(status.initialized ? "unlock" : "setup");
  if (!accepted) return false;
  const current = await privacy.status();
  if (current.recoveryConfirmed === false) return openPrivacyDialog("rotate");
  return current.initialized && current.unlocked;
}
export function privacyError(error: unknown, t: (key: string) => string) {
  const code = error instanceof Error ? error.message : String(error);
  const key = `inspiration_private.errors.${code}`;
  const translated = t(key);
  return translated === key ? t("inspiration_private.generic_error") : translated;
}
