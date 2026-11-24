import type { Metadata } from "next";
import { SsoConsentView } from "@lynse/views/mcp-authorizations";

export const metadata: Metadata = {
  title: "Lynse 账号登录",
  robots: { index: false, follow: false },
};

export default async function Page({ searchParams }: {
  searchParams: Promise<{ ticket?: string | string[] }>;
}) {
  const { ticket } = await searchParams;
  return (
    <SsoConsentView
      ticket={typeof ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : null}
      logoSrc={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/lynse-device-mark.png`}
    />
  );
}
