"use client";

import { useEffect, useRef, useReducer } from "react";
import { toast } from "sonner";
import { getDesktopLiveTranslationApi } from "./desktop-api";
import {
  initialLiveTranslationState,
  reduceLiveTranslationEvent,
} from "./state";

export function useLiveTranslation() {
  const api = getDesktopLiveTranslationApi();
  const [view, dispatch] = useReducer(
    reduceLiveTranslationEvent,
    undefined,
    initialLiveTranslationState,
  );
  // Tracks the snapshot state so error events can be classified without
  // reading React state inside the listener closure.
  const stateRef = useRef<string>("idle");

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    api.getState()
      .then((snapshot) => {
        if (!disposed) dispatch({ type: "state", snapshot });
      })
      .catch((error: unknown) => {
        if (!disposed) dispatch({ type: "error", message: String(error) });
      });
    api.onEvent((event) => {
      if (event.type === "state") stateRef.current = event.snapshot.state;
      // Capture-layer failures (no audio device, wedged engine) happen while
      // nothing is recording, where the reducer's corner Alert is the only
      // other surface — make them a toast so the user learns WHY.
      if (
        event.type === "error" &&
        stateRef.current !== "recording" &&
        stateRef.current !== "paused"
      ) {
        toast.error(event.message);
      }
      dispatch(event);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [api]);

  return { api, view };
}
