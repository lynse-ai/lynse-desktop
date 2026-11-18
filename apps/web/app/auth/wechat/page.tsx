import { WechatCallback } from "@lynse/views/auth";

export const metadata = {
  title: "微信登录",
};

// Thin wrapper around the shared WeChat callback view (state check + code
// exchange). Production uses the backend-callback architecture — WeChat
// redirects to the backend's /auth/login, which 302s onto the landing
// pages — so this route is idle there; it stays for deployments whose
// `redirect_uri` points at this origin instead.
export default function WechatCallbackRoute() {
  return <WechatCallback />;
}
