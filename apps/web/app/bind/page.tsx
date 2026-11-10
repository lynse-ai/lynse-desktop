import { AppleBindLanding } from "@lynse/views/auth";

export const metadata = {
  title: "绑定账号",
};

// Apple web login bind landing (web-bind-url): the backend 302s here with
// ?thirdPartyId=… (first login → binding) or ?error=… (failure).
export default function BindPage() {
  return <AppleBindLanding />;
}
