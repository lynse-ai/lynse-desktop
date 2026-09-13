import { useEffect, useState } from "react";
import { useWorkspaceStore } from "../store";

/**
 * Local typing buffer for the workspace file-search inputs. Typing updates
 * the field instantly; the shared store (which drives client-side filtering
 * and server queries) is only updated after `delayMs`, so keystrokes don't
 * re-filter the whole grid or fire a request each time. Stays in sync when
 * the store is changed externally (e.g. reset on navigation).
 */
export function useDebouncedSearchInput(delayMs = 200) {
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);
  const setSearchQuery = useWorkspaceStore((s) => s.setSearchQuery);
  const [input, setInput] = useState(searchQuery);

  // Follow external store changes (typing elsewhere, programmatic reset).
  useEffect(() => {
    setInput((prev) => (prev === searchQuery ? prev : searchQuery));
  }, [searchQuery]);

  useEffect(() => {
    if (input === searchQuery) return;
    const timer = window.setTimeout(() => setSearchQuery(input), delayMs);
    return () => window.clearTimeout(timer);
  }, [input, searchQuery, setSearchQuery, delayMs]);

  return { input, setInput };
}
