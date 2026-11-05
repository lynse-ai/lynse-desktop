"use client"

import { type RefObject, useLayoutEffect, useRef, useCallback, useState } from "react"

/**
 * Auto-scrolls a scroll container to the bottom when its inner content grows,
 * as long as the user hasn't scrolled up to read older content.
 *
 * Keeps the reader's position until they ask for the latest message. Changing
 * resetKey starts at the new conversation's bottom. suppressAutoScroll can
 * temporarily pause following during history prepend operations.
 */
export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  { resetKey }: { resetKey?: string | null } = {},
) {
  const stickRef = useRef(true)
  const lockRef = useRef(false)
  const [pinnedToBottom, setPinnedToBottom] = useState(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    // Switching conversations follows the new thread even if the previous
    // one was scrolled up. Background updates never reset the reader's choice.
    stickRef.current = true
    setPinnedToBottom(true)
    el.scrollTop = el.scrollHeight
    let frame = 0

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const pinned = scrollHeight - scrollTop - clientHeight < 48
      stickRef.current = pinned
      setPinnedToBottom((previous) => previous === pinned ? previous : pinned)
    }

    const onContentChange = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!lockRef.current && stickRef.current) el.scrollTop = el.scrollHeight
      })
    }

    // Observe the content as well as the viewport: images, streamed text and
    // a resized drawer can all change the bottom without a new message.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onContentChange)
    const observed = new Set<Element>()
    const observeChildren = () => {
      for (const child of observed) {
        if (child.parentElement !== el) { ro?.unobserve(child); observed.delete(child) }
      }
      for (const child of el.children) {
        if (!observed.has(child)) { ro?.observe(child); observed.add(child) }
      }
    }
    ro?.observe(el)
    observeChildren()

    // Top-level changes only. The content's ResizeObserver already covers
    // nested Markdown updates without observing every streamed text node.
    const mo = new MutationObserver(() => {
      observeChildren()
      onContentChange()
    })
    mo.observe(el, { childList: true })

    el.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onContentChange)

    return () => {
      el.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onContentChange)
      if (frame) cancelAnimationFrame(frame)
      ro?.disconnect()
      mo.disconnect()
    }
  }, [ref, resetKey])

  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    stickRef.current = true
    setPinnedToBottom(true)
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" })
  }, [ref])

  /** Temporarily suppress auto-scroll during prepend operations */
  const suppressAutoScroll = useCallback(() => {
    lockRef.current = true
    return () => { lockRef.current = false }
  }, [])

  return { suppressAutoScroll, pinnedToBottom, scrollToBottom }
}
