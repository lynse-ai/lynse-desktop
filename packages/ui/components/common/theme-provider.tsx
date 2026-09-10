import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

export { useTheme };
import { TooltipProvider } from "../ui/tooltip";

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      // Follow the macOS/OS appearance out of the box — the native vibrancy
      // material tracks the system too, so a fresh install never mixes a dark
      // UI with a light frost. Users can still pin light/dark in Settings (the
      // desktop app mirrors that choice onto the window appearance, see
      // apps/tauri/src/platform/native-theme.tsx).
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <TooltipProvider delay={500}>
        {children}
      </TooltipProvider>
    </NextThemesProvider>
  );
}
