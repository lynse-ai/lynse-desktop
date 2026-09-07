"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "../icons";
import { getDesktopInspirationApi } from "./desktop-api";
import { formatVoiceDuration } from "./use-inspiration-voice";
import type { InspirationRecord } from "./types";

/** Play/pause chip for a memo's WAV served through `local-media://`. */
export function InspirationAudioPlayer({ record }: { record: InspirationRecord }) {
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDesktopInspirationApi()?.getAudioUrl(record.id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [record.id]);

  const toggle = () => {
    if (!url) return;
    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex items-center gap-1.5 self-start rounded-full bg-muted/70 px-2.5 py-1 text-3xs text-muted-foreground transition-colors hover:bg-muted"
      title={record.audio ? formatVoiceDuration(record.audio.durationMs) : undefined}
    >
      {playing ? <Pause className="size-3" /> : <Play className="size-3" />}
      <span className="tabular-nums">
        {record.audio ? formatVoiceDuration(record.audio.durationMs) : "--:--"}
      </span>
    </button>
  );
}
