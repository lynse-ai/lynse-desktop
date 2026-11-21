"use client";

import { LYNSE_EDITION } from "@lynse/core/config";
import { useTranslation } from "@lynse/core/i18n/react";
import { buttonVariants } from "@lynse/ui/components/ui/button";
import { Terminal } from "../icons";
import { AppLink } from "../navigation";

export function DeviceAuthorizationLink() {
  const { t } = useTranslation();
  const className = buttonVariants({ size: "sm", variant: "outline" });
  const label = <><Terminal aria-hidden="true" className="size-3.5" />{t("mcpAuthorizations.device_entry")}</>;

  return LYNSE_EDITION === "cn" ? (
    <AppLink href="/login/device" className={className}>{label}</AppLink>
  ) : (
    <a href="https://www.lynse.cn/login/device" className={className}>{label}</a>
  );
}
