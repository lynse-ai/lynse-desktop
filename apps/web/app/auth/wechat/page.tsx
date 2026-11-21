import { WechatCallback } from "@lynse/views/auth";

export const metadata = {
  title: "微信登录",
};

// Thin wrapper around the shared WeChat callback view (state check + code
// exchange). WeChat's callback-domain rule fixes the authorize URL's
// `redirect_uri` to https://api.lynse.cn/auth/login, so production nginx 302s
// that callback here with the one-time `code`/`state`. This route exchanges
// the code through POST /api/auth/login — the same backend call the desktop
// shell makes from its embedded auth window.
export default function WechatCallbackRoute() {
  return <WechatCallback />;
}
