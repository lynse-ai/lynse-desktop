"use client";

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

interface DndBridgeContextValue {
  setOnDragEnd: (handler: ((event: DragEndEvent) => void) | null) => void;
}

const DndBridgeContext = createContext<DndBridgeContextValue | null>(null);

/**
 * Hook for registering a custom onDragEnd handler from within the DndProvider tree.
 * Used by WorkspaceLayout to call useMoveFiles when a file is dropped on a folder.
 */
export function useDndBridge() {
  const ctx = useContext(DndBridgeContext);
  if (!ctx) throw new Error("useDndBridge must be inside DndProvider");
  return ctx;
}

export function DndProvider({ children }: { children: ReactNode }) {
  const [activeFileTitle, setActiveFileTitle] = useState<string | null>(null);
  const handlerRef = useRef<((event: DragEndEvent) => void) | null>(null);
  const setOnDragEnd = useCallback((handler: ((event: DragEndEvent) => void) | null) => {
    handlerRef.current = handler;
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { fileTitle?: string } | undefined;
    if (data?.fileTitle) setActiveFileTitle(data.fileTitle);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveFileTitle(null);
      handlerRef.current?.(event);
    },
    [],
  );

  return (
    <DndBridgeContext.Provider value={{ setOnDragEnd }}>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {children}
        <DragOverlay>
          {activeFileTitle ? (
            <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-1.5 shadow-md">
              <span className="truncate text-xs font-medium">{activeFileTitle}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </DndBridgeContext.Provider>
  );
}
