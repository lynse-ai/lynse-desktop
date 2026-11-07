import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useTranslation } from "@lynse/core/i18n/react";
import { formatLocalTimestamp } from "./local-transcription";
import type { FileDetail, RecordMarkImage } from "./types";

interface RecordingMark {
  offsetMs: number | null;
  title: string;
  outline: string;
}

function isRecordingOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readRecordingMarks(detail: FileDetail | undefined) {
  const marks: RecordingMark[] = [];
  const offsets = new Set<number>();
  const details = Array.isArray(detail?.recordMarkResults) ? detail.recordMarkResults : [];
  for (const mark of details) {
    const offsetMs = isRecordingOffset(mark?.timeoffset) ? mark.timeoffset : null;
    const title = typeof mark?.title === "string" ? mark.title.trim() : "";
    const outline = typeof mark?.outline === "string" ? mark.outline.trim() : "";
    if (offsetMs === null && !title && !outline) continue;
    marks.push({ offsetMs, title, outline });
    if (offsetMs !== null) offsets.add(offsetMs);
  }

  // Some recordings only have offsets, and detailed marks may cover a subset.
  const rawOffsets = Array.isArray(detail?.recordMarks) ? detail.recordMarks : [];
  for (const offsetMs of rawOffsets) {
    if (!isRecordingOffset(offsetMs) || offsets.has(offsetMs)) continue;
    marks.push({ offsetMs, title: "", outline: "" });
    offsets.add(offsetMs);
  }
  marks.sort((a, b) => (a.offsetMs ?? Infinity) - (b.offsetMs ?? Infinity));

  const images = Array.isArray(detail?.markImages)
    ? detail.markImages.filter((image) => typeof image?.imageId === "string" && image.imageId.trim())
    : [];
  return { marks, images };
}

export function RecordingMarksPanel({ marks, images }: ReturnType<typeof readRecordingMarks>) {
  const { t } = useTranslation();
  const imageLabel = t("workspace.mark_images");
  return (
    <div className="space-y-4">
      {marks.length > 0 && (
        <ul aria-label={t("workspace.marks")} className="space-y-2">
          {marks.map(({ offsetMs, title, outline }, index) => (
            <li key={index} className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-3">
              {offsetMs !== null && (
                <time
                  dateTime={`PT${offsetMs / 1000}S`}
                  className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums"
                >
                  {formatLocalTimestamp(offsetMs)}
                </time>
              )}
              {(title || outline) && (
                <div className="min-w-0 space-y-1 break-words text-sm">
                  {title && <p className="font-medium">{title}</p>}
                  {outline && <p className="whitespace-pre-wrap text-muted-foreground">{outline}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {images.length > 0 && (
        <section aria-label={imageLabel}>
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">{imageLabel}</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3">
            {images.map((image) => (
              <li key={image.imageId}>
                <RecordingMarkPhoto image={image} label={imageLabel} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RecordingMarkPhoto({ image, label }: { image: RecordMarkImage; label: string }) {
  const { t, i18n } = useTranslation();
  const [originalFailed, setOriginalFailed] = useState(false);
  const [signedFailed, setSignedFailed] = useState(false);
  const originalUrl = typeof image.url === "string" ? image.url.trim() : "";
  const needsSignedUrl = !originalUrl || originalFailed;
  const { data: signedUrl, isPending } = useQuery({
    queryKey: ["recording-mark-image", image.imageId],
    queryFn: ({ signal }) => api().getWithParams<string>(
      "/api/business/file/mark/image/presign/download",
      { imageId: image.imageId },
      { signal },
    ),
    enabled: needsSignedUrl,
    retry: false,
    gcTime: 0,
  });
  const src = needsSignedUrl ? signedUrl : originalUrl;
  // 后端 timestamp 实为相对录音开始的毫秒（<24h），早先按绝对时间渲染会把
  // 8 秒显示成 1970-01-01；只有超出相对区间的大数值才按绝对时间处理。
  const rawTimestamp = Number.isFinite(image.timestamp) ? image.timestamp : NaN;
  const playbackMs = rawTimestamp >= 0 && rawTimestamp < 86_400_000 ? rawTimestamp : null;
  const date = playbackMs === null && Number.isFinite(rawTimestamp) ? new Date(rawTimestamp) : null;

  return (
    <figure className="space-y-2 rounded-lg border border-border/60 bg-card p-2">
      {src && !signedFailed ? (
        <img
          src={src}
          alt={label}
          loading="lazy"
          decoding="async"
          className="max-h-72 w-full rounded-md bg-muted/50 object-contain"
          onError={() => needsSignedUrl ? setSignedFailed(true) : setOriginalFailed(true)}
        />
      ) : (
        <p role="status" className="rounded-md bg-muted/50 px-2 py-5 text-center text-xs text-muted-foreground">
          {needsSignedUrl && isPending ? t("workspace.loading") : t("workspace.mark_image_unavailable")}
        </p>
      )}
      {playbackMs !== null ? (
        <figcaption className="text-xs text-muted-foreground tabular-nums">
          <time dateTime={`PT${playbackMs / 1000}S`}>{formatLocalTimestamp(playbackMs)}</time>
        </figcaption>
      ) : date && Number.isFinite(date.getTime()) && (
        <figcaption className="text-xs text-muted-foreground tabular-nums">
          <time dateTime={date.toISOString()}>{date.toLocaleString(i18n.language)}</time>
        </figcaption>
      )}
    </figure>
  );
}
