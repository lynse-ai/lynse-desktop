"use client";

import { useEffect, useReducer } from "react";
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
    api.onEvent((event) => dispatch(event)).then((cleanup) => {
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
