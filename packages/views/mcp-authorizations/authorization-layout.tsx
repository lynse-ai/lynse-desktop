import type { ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Avatar, AvatarFallback, AvatarImage } from "@lynse/ui/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";

export function AuthorizationFrame({ logoSrc, children }: { logoSrc: string; children: ReactNode }) {
  return (
    <main className="h-dvh overflow-y-auto bg-gradient-to-b from-primary/8 via-background to-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[33rem] flex-col justify-center gap-7 px-4 py-8 sm:px-7 sm:py-12">
        <img src={logoSrc} alt="Lynse" width={72} height={72}
          className="mx-auto size-[4.5rem] rounded-[1.35rem] shadow-sm" />
        {children}
      </div>
    </main>
  );
}

export function AuthorizationCard({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-6 rounded-3xl py-6 shadow-sm sm:py-7">
      <CardHeader className="gap-2 text-center sm:px-7">
        <CardTitle className="text-2xl font-semibold tracking-tight"><h1>{title}</h1></CardTitle>
        {description && <CardDescription className="text-sm leading-relaxed">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 sm:px-7">{children}</CardContent>
    </Card>
  );
}

export function AuthorizationAccount({ account }: { account: { name: string; avatarUrl: string | null } }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar size="lg" className="size-10">
        {account.avatarUrl && <AvatarImage src={account.avatarUrl} alt="" referrerPolicy="no-referrer" />}
        <AvatarFallback className="bg-primary/12 font-semibold text-primary">
          {Array.from(account.name)[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{t("mcpAuthorizations.device_signed_in_as")}</p>
        <p className="break-words text-sm font-semibold">{account.name}</p>
      </div>
    </div>
  );
}
