import { WechatCallback } from "@lynse/views/auth";

export const metadata = {
  title: "微信登录",
};

// WeChat Open Platform redirect target (`redirect_uri`): a thin wrapper — the
// OAuth exchange lives in the shared views package.
export default function WechatCallbackRoute() {
  return <WechatCallback />;
}
