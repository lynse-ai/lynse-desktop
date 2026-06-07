"use client";

import React from "react";
import { cn } from "@lynse/ui/lib/utils";
import { AppLink, useNavigation } from "../navigation";
import {
  Mic,
  FileText,
  BookOpen,
  MessageSquare,
  Settings,
  ChevronDown,
  LogOut,
  Plus,
  Search,
  FolderOpen,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@lynse/ui/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import { useFolders } from "../workspace/hooks/use-folders";
import { useFiles } from "../workspace/hooks/use-files";
import { useWorkspaceStore } from "../workspace/store";

function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

const toolNav = [
  { key: "chat", label: "AI Chat", icon: MessageSquare, path: "/chat" },
  { key: "settings", label: "Settings", icon: Settings, path: "/settings" },
];

interface AppSidebarProps {
  topSlot?: React.ReactNode;
  searchSlot?: React.ReactNode;
  headerClassName?: string;
  headerStyle?: React.CSSProperties;
}

export function AppSidebar({ topSlot, searchSlot, headerClassName, headerStyle }: AppSidebarProps = {}) {
  const { pathname } = useNavigation();

  return (
    <Sidebar variant="inset">
      {topSlot}
      <SidebarHeader className={cn("py-3", headerClassName)} style={headerStyle}>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton>
                    <span className="flex size-5 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
                      L
                    </span>
                    <span className="flex-1 truncate font-medium">Lynse</span>
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent
                className="w-auto min-w-56"
                align="start"
                side="bottom"
                sideOffset={4}
              >
                <DropdownMenuItem>
                  <Settings className="h-3.5 w-3.5" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">
                  <LogOut className="h-3.5 w-3.5" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarMenu>
          {searchSlot && (
            <SidebarMenuItem>{searchSlot}</SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground">
              <Plus />
              <span>New Recording</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {/* Recordings link */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={isNavActive(pathname, "/recordings")}
                  render={<AppLink href="/recordings" />}
                  className="text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                >
                  <Mic />
                  <span>Recordings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Folder tree — only when on workspace routes */}
              <WorkspaceFolderTree />

              {/* Other workspace nav */}
              {[
                { key: "meetings", label: "Meetings", icon: FileText, path: "/meetings" },
                { key: "knowledge", label: "Knowledge Base", icon: BookOpen, path: "/knowledge" },
                { key: "files", label: "Files", icon: FolderOpen, path: "/files" },
              ].map((item) => {
                const isActive = isNavActive(pathname, item.path);
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={isActive}
                      render={<AppLink href={item.path} />}
                      className="text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Tools</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {toolNav.map((item) => {
                const isActive = isNavActive(pathname, item.path);
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={isActive}
                      render={<AppLink href={item.path} />}
                      className="text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <div className="flex justify-end">
          <SidebarMenuButton className="text-muted-foreground w-auto">
            <Search className="size-4" />
          </SidebarMenuButton>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Folder list rendered inside the sidebar under Recordings */
function WorkspaceFolderTree() {
  const { pathname } = useNavigation();
  const selectedFolderId = useWorkspaceStore((s) => s.selectedFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const { data: folders } = useFolders();
  const { data: files } = useFiles({ pageNum: 1, pageSize: 200 });

  // Only show on workspace routes
  const workspaceRoutes = ["/recordings", "/meetings", "/knowledge", "/files"];
  const isWorkspace = workspaceRoutes.some((r) => pathname.startsWith(r));
  if (!isWorkspace) return null;

  const folderItems = Array.isArray(folders)
    ? folders.map((f) => {
        const obj = f as Record<string, unknown>;
        return {
          id: String(obj.id ?? ""),
          name: String(obj.folderName ?? ""),
          color: obj.color as string | undefined,
        };
      })
    : [];

  const countsByFolder = new Map<string, number>();
  let ungrouped = 0;
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f.folderId) countsByFolder.set(f.folderId, (countsByFolder.get(f.folderId) ?? 0) + 1);
      else ungrouped++;
    }
  }

  return (
    <div className="ml-3 border-l pl-2 py-0.5 space-y-px">
      {folderItems.map((folder) => (
        <button
          key={folder.id}
          onClick={() => selectFolder(folder.id)}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
            selectedFolderId === folder.id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/70"
          }`}
        >
          {folder.color ? (
            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: folder.color }} />
          ) : (
            <FolderOpen className="size-3.5 shrink-0" />
          )}
          <span className="flex-1 truncate text-left">{folder.name}</span>
          <span className="text-[10px] tabular-nums">{countsByFolder.get(folder.id) ?? 0}</span>
        </button>
      ))}
      <button
        onClick={() => selectFolder("__uncategorized__")}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
          selectedFolderId === "__uncategorized__"
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent/70"
        }`}
      >
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="flex-1 truncate text-left">Uncategorized</span>
        <span className="text-[10px] tabular-nums">{ungrouped}</span>
      </button>
    </div>
  );
}
