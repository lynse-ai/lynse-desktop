"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import { Bot, Check, ChevronDown, WorkBuddy } from "../icons";
import type { ChatAssistant } from "../workspace/types";

/**
 * Header assistant switcher for the chat page: shows the active assistant's
 * name with a disclosure chevron; the dropdown swaps between the Lynse cloud
 * assistant ("小灵助手") and the user's authorized WorkBuddy. The choice is
 * global (store-owned and persisted), so the right-hand chat panel follows it.
 */
export function AssistantSwitcher({
  activeAssistant,
  onSelect,
  disabled,
}: {
  activeAssistant: ChatAssistant;
  onSelect: (assistant: ChatAssistant) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  const options: { id: ChatAssistant; label: string; icon: typeof Bot }[] = [
    { id: "lynse", label: t("chat.assistant_lynse"), icon: Bot },
    { id: "workbuddy", label: t("chat.assistant_workbuddy"), icon: WorkBuddy },
  ];
  const current = options.find((option) => option.id === activeAssistant) ?? options[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        title={t("chat.switch_assistant")}
        aria-label={t("chat.switch_assistant")}
        data-tauri-drag-region={false}
        className={cn(
          "group flex max-w-56 items-center gap-1 rounded-lg px-2 py-1 transition-colors",
          "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
          disabled && "pointer-events-none opacity-60",
        )}
      >
        <current.icon className="size-3.5 shrink-0 text-primary/80" />
        <span className="truncate text-13 font-semibold tracking-tight text-foreground">
          {current.label}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onClick={() => onSelect(option.id)}>
            {activeAssistant === option.id ? (
              <Check className="size-3 text-primary" />
            ) : (
              <span className="size-3" />
            )}
            <option.icon
              className={cn(
                "size-3.5 shrink-0",
                activeAssistant === option.id ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className={cn(activeAssistant !== option.id && "text-muted-foreground")}>
              {option.label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
