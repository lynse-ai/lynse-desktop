"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { localTodoFourStates, setTodoStatus, todoStatus, type TodoItem, type TodoStatus } from "./todo-api";

export function TodoStateControl({ todo, onSaved }: { todo: TodoItem; onSaved: (todo: TodoItem) => void }) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { let active = true; void localTodoFourStates().then(value => { if (active) setAvailable(value); }); return () => { active = false; }; }, []);
  if (todo.backend || !available) return null;
  return <div className="space-y-2 py-2">
    <label className="flex items-center justify-between gap-3 text-sm"><span>{t("memory_manager.todo_status")}</span><select className="rounded-md border border-input bg-background px-3 py-2" value={todoStatus(todo)} disabled={busy} onChange={event => { const value = event.target.value as TodoStatus; const operation = crypto.randomUUID(); setBusy(true); setError(false); void setTodoStatus(todo, value, operation).then(onSaved).catch(() => setError(true)).finally(() => setBusy(false)); }}>{["open", "doing", "done", "cancelled"].map(value => <option value={value} key={value}>{t(`memory_manager.todo_${value}`)}</option>)}</select></label>
    {error && <p role="alert" className="text-sm text-destructive">{t("memory_manager.changed")}</p>}
    {todo.statusHistory && <ol className="max-h-24 overflow-y-auto text-xs text-muted-foreground" aria-label={t("memory_manager.todo_history")}>{todo.statusHistory.map(entry => <li key={entry.version}>{entry.at} · {t(`memory_manager.todo_${entry.from}`)} → {t(`memory_manager.todo_${entry.to}`)}</li>)}</ol>}
  </div>;
}
