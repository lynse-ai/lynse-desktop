import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";
import { installTauriBridge } from "./tauri-bridge";

async function bootstrap() {
  await installTauriBridge();
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
}

void bootstrap();
