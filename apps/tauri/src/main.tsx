import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import { installTauriBridge } from "./tauri-bridge";

async function bootstrap() {
  const windowKind = new URLSearchParams(window.location.search).get("window");
  // Transparent floating windows must render the webview body transparent too,
  // otherwise the theme background shows through as a square frame.
  if (windowKind === "live-subtitles") {
    document.documentElement.classList.add("subtitle-window");
  }
  if (windowKind === "recording-island") {
    document.documentElement.classList.add("recording-island-window");
  }

  await installTauriBridge();
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
}

void bootstrap();
