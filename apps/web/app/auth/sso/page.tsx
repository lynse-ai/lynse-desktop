import { SsoCallback } from "@lynse/views/auth";

export const metadata = {
  title: "Lynse 账号登录",
};

// Thin wrapper around the shared account-center SSO callback view (state
// check + PKCE code exchange at the account center's /oauth/token). Hidden
// unless NEXT_PUBLIC_LYNSE_SSO_* is configured — the login page only shows
// the entry when the config exists.
export default function SsoCallbackRoute() {
  return <SsoCallback />;
}
