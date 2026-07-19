"use client";

import { useState, useEffect } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Loader2, Plus, Trash2 } from "../icons";
import type {
  DesktopLocalTranscriptionApi,
  SttProviderConfig,
  TranscribeConfig,
} from "../workspace/local-transcription";
import type { LocalHotwordPackage } from "../workspace/types";

type LangEntry = { language: string; config: SttProviderConfig };

function FunasrFields({
  config,
  hotwordPackages,
  onChange,
}: {
  config: SttProviderConfig;
  hotwordPackages: LocalHotwordPackage[];
  onChange: (next: SttProviderConfig) => void;
}) {
  const speakers = config.expected_speakers ?? null;
  return (
    <div className="mt-2 space-y-2 rounded bg-background p-2">
      <div className="space-y-1">
        <Label className="text-[11px]">预期说话人数</Label>
        <Input
          type="number"
          min={0}
          value={speakers ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            const num = raw === "" ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
            onChange({ ...config, expected_speakers: num });
          }}
          className="h-8 text-xs"
          placeholder="自动"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">热词包</Label>
        <select
          value={config.hotword_package_id ?? ""}
          onChange={(event) =>
            onChange({ ...config, hotword_package_id: event.target.value || null })
          }
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="">不使用</option>
          {hotwordPackages.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name}（{pkg.terms.length}词）
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function SttConfigSection({
  api,
  hotwordPackages,
}: {
  api: DesktopLocalTranscriptionApi;
  hotwordPackages: LocalHotwordPackage[];
}) {
  const [config, setConfig] = useState<TranscribeConfig | null>(null);
  const [langEntries, setLangEntries] = useState<LangEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getSttConfig()
      .then((loaded) => {
        if (!active) return;
        setConfig(loaded);
        setLangEntries(
          Object.entries(loaded.per_language ?? {}).map(([language, cfg]) => ({
            language,
            config: cfg,
          })),
        );
      })
      .catch((e: unknown) =>
        active && setError(e instanceof Error ? e.message : "加载 STT 配置失败"),
      );
    return () => {
      active = false;
    };
  }, [api]);

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const next: TranscribeConfig = {
        default: config.default ?? null,
        per_language: Object.fromEntries(
          langEntries
            .filter((entry) => entry.language.trim())
            .map((entry) => [entry.language.trim(), entry.config]),
        ),
      };
      await api.saveSttConfig(next);
      setConfig(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return (
      <div className="rounded-md border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
        正在加载 STT 路由配置…
      </div>
    );
  }

  const defaultConfig: SttProviderConfig = config.default ?? { provider: "funasr" };

  function updateDefault(next: SttProviderConfig) {
    setConfig((current) => (current ? { ...current, default: next } : current));
  }

  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      <p className="text-xs font-medium">STT 路由配置</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        设置默认转写引擎，以及按语言（如 zh / en）覆盖引擎与参数。解析顺序：单条配置 → 按语言 → 默认。
      </p>

      <div className="mt-2 space-y-1">
        <Label className="text-[11px]">默认引擎</Label>
        <select
          value={defaultConfig.provider}
          onChange={(event) =>
            updateDefault({ provider: event.target.value as SttProviderConfig["provider"] })
          }
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="funasr">FunASR（本地）</option>
        </select>
        {defaultConfig.provider === "funasr" && (
          <FunasrFields
            config={defaultConfig}
            hotwordPackages={hotwordPackages}
            onChange={updateDefault}
          />
        )}
      </div>

      <div className="mt-3 space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">按语言路由</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              setLangEntries((list) => [
                ...list,
                { language: "", config: { provider: "funasr" } },
              ])
            }
          >
            <Plus className="mr-1 size-3" />
            添加语言
          </Button>
        </div>

        {langEntries.length === 0 && (
          <p className="text-[11px] text-muted-foreground">暂无按语言覆盖，全部使用默认引擎。</p>
        )}

        {langEntries.map((entry, index) => (
          <div key={index} className="space-y-2 rounded bg-background p-2">
            <div className="flex items-center gap-2">
              <Input
                value={entry.language}
                onChange={(event) =>
                  setLangEntries((list) =>
                    list.map((item, i) =>
                      i === index ? { ...item, language: event.target.value } : item,
                    ),
                  )
                }
                placeholder="语言代码，如 zh / en"
                className="h-8 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  setLangEntries((list) => list.filter((_, i) => i !== index))
                }
              >
                <Trash2 className="mr-1 size-3" />
                删除
              </Button>
            </div>
            <select
              value={entry.config.provider}
              onChange={(event) =>
                setLangEntries((list) =>
                  list.map((item, i) =>
                    i === index
                      ? { ...item, config: { provider: event.target.value as SttProviderConfig["provider"] } }
                      : item,
                  ),
                )
              }
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="funasr">FunASR（本地）</option>
            </select>
            {entry.config.provider === "funasr" && (
              <FunasrFields
                config={entry.config}
                hotwordPackages={hotwordPackages}
                onChange={(next) =>
                  setLangEntries((list) =>
                    list.map((item, i) => (i === index ? { ...item, config: next } : item)),
                  )
                }
              />
            )}
          </div>
        ))}
      </div>

      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}

      <Button
        type="button"
        size="sm"
        className="mt-3 h-7 text-xs"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
        保存配置
      </Button>
    </div>
  );
}
