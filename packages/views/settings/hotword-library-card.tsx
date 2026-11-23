"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listHotwords,
  addHotword,
  updateHotword,
  deleteHotword,
  type HotwordVO,
  ApiError,
} from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Badge } from "@lynse/ui/components/ui/badge";
import { toast } from "sonner";
import {
  Tag,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Loader2,
  Search,
  AlertCircle,
} from "../icons";

const WEIGHT_OPTIONS = [1, 2, 3, 4, 5, 50] as const;
const MAX_HOTWORDS = 500;
const MAX_CONTENT_LENGTH = 20;

export function HotwordLibraryCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const authenticated = useAuthStore((state) => state.isAuthenticated);

  // Form states
  const [newContent, setNewContent] = useState("");
  const [newWeight, setNewWeight] = useState<number>(3);
  const [clientError, setClientError] = useState<string | null>(null);

  // Edit states
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editWeight, setEditWeight] = useState<number>(3);

  // Search filter
  const [searchQuery, setSearchQuery] = useState("");

  const {
    data: hotwords = [],
    isLoading,
    isError,
    error: fetchError,
    refetch,
  } = useQuery({
    queryKey: ["hotwords"],
    queryFn: ({ signal }) => listHotwords(signal),
    enabled: authenticated,
  });

  const addMutation = useMutation({
    mutationFn: (input: { content: string; weight?: number }) => addHotword(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hotwords"] });
      setNewContent("");
      setNewWeight(3);
      setClientError(null);
      toast.success(t("settings.hotword_add_success"));
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.message : t("settings.hotword_error_duplicate");
      setClientError(message);
      toast.error(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; content: string; weight?: number }) => updateHotword(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hotwords"] });
      setEditingId(null);
      setClientError(null);
      toast.success(t("settings.hotword_update_success"));
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.message : String(err);
      setClientError(message);
      toast.error(message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteHotword(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hotwords"] });
      toast.success(t("settings.hotword_delete_success"));
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.message : String(err);
      toast.error(message);
    },
  });

  const filteredHotwords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return hotwords;
    return hotwords.filter((item) => item.content.toLowerCase().includes(q));
  }, [hotwords, searchQuery]);

  function handleAdd() {
    setClientError(null);
    const trimmed = newContent.trim();
    if (!trimmed) {
      setClientError(t("settings.hotword_error_empty"));
      return;
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      setClientError(t("settings.hotword_error_too_long"));
      return;
    }
    if (hotwords.length >= MAX_HOTWORDS) {
      setClientError(t("settings.hotword_error_limit"));
      return;
    }
    const duplicate = hotwords.some(
      (h) => h.content.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) {
      setClientError(t("settings.hotword_error_duplicate"));
      return;
    }

    addMutation.mutate({ content: trimmed, weight: newWeight });
  }

  function startEdit(item: HotwordVO) {
    setEditingId(item.id);
    setEditContent(item.content);
    setEditWeight(item.weight);
    setClientError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setClientError(null);
  }

  function handleSaveEdit() {
    if (!editingId) return;
    setClientError(null);
    const trimmed = editContent.trim();
    if (!trimmed) {
      setClientError(t("settings.hotword_error_empty"));
      return;
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      setClientError(t("settings.hotword_error_too_long"));
      return;
    }
    const duplicate = hotwords.some(
      (h) => h.id !== editingId && h.content.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (duplicate) {
      setClientError(t("settings.hotword_error_duplicate"));
      return;
    }

    updateMutation.mutate({ id: editingId, content: trimmed, weight: editWeight });
  }

  function handleDelete(id: string) {
    if (typeof window !== "undefined" && !window.confirm(t("settings.hotword_delete_confirm"))) {
      return;
    }
    deleteMutation.mutate(id);
  }

  if (!authenticated) {
    return null;
  }

  const isLimitReached = hotwords.length >= MAX_HOTWORDS;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <Tag className="size-3.5" />
            {t("settings.hotword_library")}
          </CardTitle>
          <Badge variant="secondary" className="text-2xs font-normal">
            {t("settings.hotword_count_limit", {
              count: hotwords.length,
              max: MAX_HOTWORDS,
            })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("settings.hotword_library_desc")}
        </p>

        {/* Add hotword form */}
        <div className="space-y-2 rounded-lg border bg-muted/20 p-2.5">
          <div className="flex items-center gap-2">
            <Input
              value={newContent}
              onChange={(e) => {
                setNewContent(e.target.value);
                if (clientError) setClientError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder={t("settings.hotword_content_placeholder")}
              maxLength={MAX_CONTENT_LENGTH}
              disabled={isLimitReached || addMutation.isPending}
              className="h-8 text-xs flex-1"
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-2xs text-muted-foreground">{t("settings.hotword_weight_label")}:</span>
              <select
                value={newWeight}
                onChange={(e) => setNewWeight(Number(e.target.value))}
                disabled={isLimitReached || addMutation.isPending}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-primary"
                title={t("settings.hotword_weight_hint")}
              >
                {WEIGHT_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w === 3 ? `${w} (${t("settings.stt_auto") || "默认"})` : w}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleAdd}
              disabled={isLimitReached || !newContent.trim() || addMutation.isPending}
              className="h-8 text-xs shrink-0 gap-1 px-3"
            >
              {addMutation.isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              {addMutation.isPending ? t("settings.hotword_adding") : t("settings.hotword_add_btn")}
            </Button>
          </div>

          {clientError && (
            <div className="flex items-center gap-1.5 text-2xs text-destructive">
              <AlertCircle className="size-3 shrink-0" />
              <span>{clientError}</span>
            </div>
          )}
        </div>

        {/* Search bar when item count exceeds 5 */}
        {hotwords.length > 5 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("settings.hotword_search_placeholder")}
              className="h-7 pl-7 text-xs"
            />
          </div>
        )}

        {/* Hotwords list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-xs text-muted-foreground gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            <span>{t("settings.hotword_loading")}</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center gap-2 py-4 text-xs text-destructive">
            <p>{fetchError instanceof Error ? fetchError.message : String(fetchError)}</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()} className="h-7 text-xs">
              {t("memory_manager.connection_retry") || "重试"}
            </Button>
          </div>
        ) : filteredHotwords.length === 0 ? (
          <p className="rounded-md border bg-muted/20 p-3 text-center text-2xs text-muted-foreground">
            {searchQuery ? t("settings.stt_no_models") || "未找到匹配的热词" : t("settings.hotword_empty")}
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
            {filteredHotwords.map((item) => {
              const isEditing = editingId === item.id;
              if (isEditing) {
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border border-primary/50 bg-background p-1.5 text-xs"
                  >
                    <Input
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      maxLength={MAX_CONTENT_LENGTH}
                      className="h-7 text-xs flex-1"
                      autoFocus
                    />
                    <select
                      value={editWeight}
                      onChange={(e) => setEditWeight(Number(e.target.value))}
                      className="h-7 rounded-md border border-input bg-background px-1.5 text-xs outline-none"
                    >
                      {WEIGHT_OPTIONS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-primary"
                      onClick={handleSaveEdit}
                      disabled={updateMutation.isPending || !editContent.trim()}
                      title={t("settings.hotword_save_btn")}
                    >
                      {updateMutation.isPending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Check className="size-3" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground"
                      onClick={cancelEdit}
                      disabled={updateMutation.isPending}
                      title={t("settings.hotword_cancel_btn")}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                );
              }

              return (
                <div
                  key={item.id}
                  className="group flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{item.content}</span>
                    <Badge
                      variant={item.weight === 50 ? "default" : "secondary"}
                      className="text-2xs px-1.5 py-0 h-4"
                    >
                      {t("settings.hotword_weight_label")} {item.weight}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.createTime && (
                      <span className="text-2xs text-muted-foreground hidden sm:inline">
                        {item.createTime.split(" ")[0]}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => startEdit(item)}
                      title={t("settings.hotword_edit_btn")}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(item.id)}
                      disabled={deleteMutation.isPending}
                      title={t("settings.hotword_delete_btn")}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
