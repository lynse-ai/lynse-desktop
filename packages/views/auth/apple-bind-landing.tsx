"use client";

import { useEffect, useState } from "react";
import { useAuthStore } from "@lynse/core/auth";
import type { AuthSession } from "@lynse/core/auth/session";
import { useTranslation } from "@lynse/core/i18n/react";
import { wechatSessionFromVo, type WechatLoginVo } from "@lynse/core/auth/wechat";
import { WechatBindForm } from "./wechat-bind-form";
import { AgreementCheckbox } from "./agreement-checkbox";
import { useNavigation } from "../navigation";
import { Loader2 } from "../icons";

/**
 * Landing page for the Apple web login 302 redirects (web-bind-url from the
 * backend's Nacos config):
 *   ?thirdPartyId={apple_sub}  → the standalone binding card (cn binds a
 *                                phone, intl binds an email)
 *   ?error={key}               → a user-facing failure notice
 * A successful bind responds with the session token directly (bind = login),
 * so completing the form signs the user in.
 */

/** Backend error keys → the few user-facing messages worth translating. */
function appleErrorMessage(key: string, t: (k: string) => string): string {
  if (key === "error.apple.state.invalid") return t("auth.apple_err_state");
  if (key === "error.apple.config.missing") return t("auth.apple_err_config");
  if (key === "error.sub.already.bind") return t("auth.apple_err_already_bound");
  // error.apple.code.exchange.failed / identity.token.invalid / user_cancelled
  // and anything unknown: the user can simply retry.
  return t("auth.login_failed");
}

export function AppleBindLanding() {
  const { t } = useTranslation();
  const completeLogin = useAuthStore((s) => s.completeLogin);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [thirdPartyId, setThirdPartyId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const id = params.get("thirdPartyId");
    if (error) {
      setErrorKey(error);
    } else if (id) {
      setThirdPartyId(id);
    } else {
      setInvalid(true);
    }
  }, []);

  if (invalid) {
    return <LandingNotice message={t("auth.login_failed")} />;
  }

  if (errorKey) {
    return <LandingNotice message={appleErrorMessage(errorKey, t)} />;
  }

  return <AppleBindCard thirdPartyId={thirdPartyId} onComplete={completeLogin} />;
}

function LandingNotice({ message }: { message: string }) {
  const navigation = useNavigation();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm space-y-4 text-center">
        <p className="text-sm text-muted-foreground">{message}</p>
        <button type="button" onClick={() => navigation.push("/home")}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          返回登录
        </button>
      </div>
    </main>
  );
}

function AppleBindCard({
  thirdPartyId,
  onComplete,
}: {
  thirdPartyId: string | null;
  onComplete: (session: AuthSession) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!thirdPartyId) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <WechatBindForm
          thirdPartyId={thirdPartyId}
          authType="APPLE"
          agreed={agreed}
          variant="standalone"
          onBound={(vo: WechatLoginVo) => {
            const session = wechatSessionFromVo(vo);
            if (!session) {
              setError("bind-failed");
              return;
            }
            // The landing query carries a one-time identity handle; keep it
            // out of history once consumed.
            window.history.replaceState(null, "", window.location.pathname);
            onComplete(session);
          }}
        />
        <AgreementCheckbox agreed={agreed} onToggle={() => setAgreed(!agreed)} onLink={() => {}} />
        {error && <p className="mt-3 text-center text-xs text-destructive">{error}</p>}
      </div>
    </main>
  );
}
