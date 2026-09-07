"use client";

/** Date/time formatting helpers shared by the feed and the detail dialog. */

export function formatCardDateTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayGroupLabel(iso: string, language: string, t: (key: string) => string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const key = dayKey(iso);
  const now = new Date();
  if (key === dayKey(now.toISOString())) return t("inspiration.group_today");
  if (key === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return t("inspiration.group_yesterday");
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
  }).format(date);
}
