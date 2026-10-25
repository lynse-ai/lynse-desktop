"use client";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { getDesktopInspirationApi } from "./desktop-api";
import { useInspirationCloud } from "./use-inspiration-cloud";
import { closePrivacyDialog, ensureInspirationUnlocked, privacyError, useInspirationPrivacy, type PrivacyDialogMode } from "./privacy-state";
import { useInspirationDetailStore } from "./detail-store";
import { Loader2, LockKeyhole } from "../icons";

export function InspirationPrivacySupervisor() {
  const queryClient = useQueryClient();
  useInspirationCloud(true);
  useEffect(() => {
    const privacy = getDesktopInspirationApi()?.privacy;
    if (!privacy) return;
    let stopped = false;
    let dispose: (() => void) | undefined;
    void privacy.onLocked(() => {
      closePrivacyDialog(false);
      useInspirationPrivacy.setState((state) => ({ generation: state.generation + 1 }));
      void queryClient.cancelQueries({ queryKey: ["inspiration-detail"] });
      queryClient.removeQueries({ queryKey: ["inspiration-detail"] });
      useInspirationDetailStore.getState().closeDetail();
      window.dispatchEvent(new Event("inspiration-private-lock"));
      void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
    }).then((cleanup) => { if (stopped) cleanup(); else dispose = cleanup; });
    let lastTouch = 0;
    const touch = () => {
      if (Date.now() - lastTouch < 15_000) return;
      lastTouch = Date.now();
      void privacy.touch().catch(() => undefined);
    };
    const hide = () => { if (document.visibilityState === "hidden") void privacy.lock(); };
    document.addEventListener("pointerdown", touch);
    document.addEventListener("keydown", touch);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => { stopped = true; dispose?.(); document.removeEventListener("pointerdown", touch); document.removeEventListener("keydown", touch); document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", hide); };
  }, [queryClient]);
  return <PrivacyDialog />;
}

function PrivacyDialog() {
  const { t } = useTranslation();
  const mode = useInspirationPrivacy((s) => s.dialog);
  const api = getDesktopInspirationApi()?.privacy;
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Array<{ id: string; revoked_at: string }>>([]);
  const [revoke, setRevoke] = useState<string[]>([]);
  const [full, setFull] = useState(false);
  const [legacyCount, setLegacyCount] = useState(0);
  const [claim, setClaim] = useState(false);
  const [pairCreated, setPairCreated] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [afterUnlock, setAfterUnlock] = useState<PrivacyDialogMode | null>(null);
  useEffect(() => {
    setPassword(""); setConfirm(""); setRecovery(""); setRecoveryCode(""); setSaved(false); setPending(false); setError(""); setBusy(false); setPairCreated(false);
    if (mode === "manage" && api) {
      void api.status().then((value) => setDeviceId(value.deviceId ?? ""));
      void api.devices().then((value) => setDevices(value.devices)).catch(() => setDevices([]));
      void api.legacy().then((value) => setLegacyCount(value.count)).catch(() => setLegacyCount(0));
    }
  }, [mode, api]);
  const changeMode = (dialog: PrivacyDialogMode) => useInspirationPrivacy.setState({ dialog });
  const requireUnlocked = async (target: PrivacyDialogMode) => {
    if ((await api?.status())?.unlocked) changeMode(target);
    else { setAfterUnlock(target); changeMode("unlock"); }
  };
  const finish = async () => {
    setPassword(""); setConfirm(""); setRecovery("");
    await queryClient.invalidateQueries({ queryKey: ["inspirations"] });
    closePrivacyDialog(true);
  };
  const submit = async () => {
    if (!api || !mode || busy) return;
    if (recoveryCode) { if (saved) { try { await api.confirmRecovery(); setRecoveryCode(""); closePrivacyDialog(!pending); } catch (cause) { setError(privacyError(cause,t)); } } return; }
    if (["setup", "recover", "pair", "password", "rotate"].includes(mode) && mode !== "rotate" && (password.length < 12 || password !== confirm)) { setError(t(password !== confirm ? "inspiration_private.password_mismatch" : "inspiration_private.password_hint")); return; }
    setBusy(true); setError("");
    const session = useInspirationPrivacy.getState();
    const current = () => { const state = useInspirationPrivacy.getState(); return state.accountScope === session.accountScope && state.generation === session.generation && state.dialog === mode; };
    try {
      if (mode === "setup") { const result = await api.initialize(password); if (!current()) return; setRecoveryCode(result.recoveryCode); setPending(result.cloudPending); setPassword(""); setConfirm(""); }
      else if (mode === "unlock") { await api.unlock(password); if (!current()) return; if (afterUnlock) { changeMode(afterUnlock); setAfterUnlock(null); } else await finish(); }
      else if (mode === "recover") { await api.recover(password, recovery); if (current()) await finish(); }
      else if (mode === "password") { await api.changePassword(password); if (current()) await finish(); }
      else if (mode === "pair") { const result = await api.requestDevice(password); if (!current()) return; setRequestId(result.requestId); setFingerprint(result.fingerprint); setPassword(""); setConfirm(""); setPairCreated(true); }
      else if (mode === "approve") { await api.approveDevice(requestId.trim(), fingerprint.trim()); if (current()) await finish(); }
      else if (mode === "finish") { await api.finishDevice(requestId.trim(), password); if (current()) await finish(); }
      else if (mode === "rotate") { const result = await api.rotate(revoke, password, full); if (!current()) return; setRecoveryCode(result.recoveryCode); setPassword(""); }
    } catch (cause) { setError(privacyError(cause, t)); } finally { setBusy(false); }
  };
  const passwordNeeded = mode && !["manage", "approve"].includes(mode) && !pairCreated && !recoveryCode;
  const confirmationNeeded = mode && ["setup", "recover", "pair", "password"].includes(mode);
  const title = t(`inspiration_private.${({ setup: "setup", unlock: "unlock", manage: "manage", recover: "recover", pair: "pair", approve: "approve", finish: "finish_pair", password: "password_change", rotate: "revoke" } as const)[mode ?? "manage"]}`);
  return <Dialog open={!!mode} onOpenChange={(open) => { if (!open && !busy) { setPassword(""); setRecovery(""); setRecoveryCode(""); closePrivacyDialog(false); } }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><LockKeyhole className="size-4" />{title}</DialogTitle><DialogDescription>{t("inspiration_private.no_ai")}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {recoveryCode ? <div className="space-y-3"><p className="text-sm text-muted-foreground">{t("inspiration_private.recovery_hint")}</p><pre className="select-text break-all whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm">{recoveryCode}</pre>{pending && <p role="status" className="text-sm">{t("inspiration_private.cloud_pending")}</p>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />{t("inspiration_private.recovery_saved")}</label></div> : <>
        {passwordNeeded && <label className="block space-y-2 text-sm"><span>{t("inspiration_private.password")}</span><Input aria-label={t("inspiration_private.password")} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />{confirmationNeeded && <span className="block text-xs text-muted-foreground">{t("inspiration_private.password_hint")}</span>}</label>}
        {confirmationNeeded && !pairCreated && <label className="block space-y-2 text-sm"><span>{t("inspiration_private.confirm_password")}</span><Input type="password" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>}
        {mode === "recover" && <label className="block space-y-2 text-sm"><span>{t("inspiration_private.recovery")}</span><Input value={recovery} autoComplete="off" onChange={(e) => setRecovery(e.target.value)} /></label>}
        {(mode === "approve" || mode === "finish" || pairCreated) && <label className="block space-y-2 text-sm"><span>{t("inspiration_private.request_id")}</span><Input value={requestId} readOnly={pairCreated} onChange={(e) => setRequestId(e.target.value)} /></label>}
        {(mode === "approve" || pairCreated) && <label className="block space-y-2 text-sm"><span>{t("inspiration_private.fingerprint")}</span><Input value={fingerprint} readOnly={pairCreated} onChange={(e) => setFingerprint(e.target.value)} /></label>}
        {pairCreated && <><p className="text-sm text-muted-foreground">{t("inspiration_private.pair_hint")}</p><Button onClick={() => changeMode("finish")}>{t("inspiration_private.finish_pair")}</Button></>}
        {(mode === "setup" || mode === "unlock") && <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => changeMode("recover")}>{t("inspiration_private.recover")}</Button><Button variant="ghost" size="sm" onClick={() => changeMode("pair")}>{t("inspiration_private.pair")}</Button><Button variant="ghost" size="sm" onClick={() => changeMode("finish")}>{t("inspiration_private.finish_pair")}</Button></div>}
        {mode === "manage" && <div className="space-y-4"><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { closePrivacyDialog(false); void ensureInspirationUnlocked().catch((cause) => setError(privacyError(cause, t))); }}>{t("inspiration_private.unlock")}</Button><Button variant="outline" onClick={() => { void api?.lock(); closePrivacyDialog(false); }}>{t("inspiration_private.lock")}</Button><Button variant="outline" onClick={() => void requireUnlocked("password")}>{t("inspiration_private.password_change")}</Button><Button variant="outline" onClick={() => void requireUnlocked("approve")}>{t("inspiration_private.approve")}</Button><Button variant="outline" onClick={() => changeMode("recover")}>{t("inspiration_private.recover")}</Button></div>
          <Button variant="outline" onClick={() => { setRevoke([]); setFull(true); changeMode("rotate"); }}>{t("inspiration_private.full_reencrypt")}</Button><p className="text-sm font-medium">{t("inspiration_private.devices")}</p>{devices.map((device) => <div key={device.id} className="flex items-center justify-between gap-2 text-xs"><span className="truncate">{device.id}</span><Button variant="ghost" size="sm" disabled={!!device.revoked_at || device.id === deviceId} onClick={() => { setRevoke([device.id]); changeMode("rotate"); }}>{t(device.revoked_at ? "inspiration_private.revoked" : "inspiration_private.revoke")}</Button></div>)}
          {legacyCount > 0 && <section className="space-y-3 border-t pt-3"><p className="text-sm">{t("inspiration_private.legacy")} ({legacyCount})</p><p className="text-xs text-muted-foreground">{t("inspiration_private.legacy_hint")}</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} />{t("inspiration_private.legacy_confirm")}</label><Button disabled={!claim || busy} onClick={() => { setBusy(true); void api?.claimLegacy().then(finish).catch((cause) => setError(privacyError(cause, t))).finally(() => setBusy(false)); }}>{t("inspiration_private.legacy_claim")}</Button></section>}
        </div>}
        {mode === "rotate" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />{t("inspiration_private.full_reencrypt")}</label>}
      </>}
      {mode !== "manage" && !pairCreated && <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => closePrivacyDialog(false)}>{t("inspiration_private.cancel")}</Button><Button disabled={busy || (!!recoveryCode && !saved)} onClick={() => void submit()}>{busy && <Loader2 className="size-4 animate-spin" />}{t("inspiration_private.continue")}</Button></div>}
    </DialogContent>
  </Dialog>;
}
