import { GoogleDesktopRelay } from "@lynse/views/auth";

export const metadata = {
  title: "Google 登录",
};

// Google sign-in relay for the desktop's standalone auth window: this page
// runs the Firebase redirect round trip inside that window and hands the ID
// token to the desktop via the intercepted done marker
// (/auth/google-desktop/done#identityToken=…&nonce=…). Visits without the
// desktop's ?nonce stay inert.
export default function GoogleDesktopRelayRoute() {
  return <GoogleDesktopRelay />;
}
