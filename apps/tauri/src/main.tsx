import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import { installTauriBridge } from "./tauri-bridge";

async function bootstrap() {
  const subtitleWindow =
    new URLSearchParams(window.location.search).get("window") === "live-subtitles";
  if (subtitleWindow) {
    document.documentElement.classList.add("subtitle-window");
  }

  await installTauriBridge();
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
}

void bootstrap();
