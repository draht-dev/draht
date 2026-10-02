import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerServiceWorker } from "./lib/registerServiceWorker.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("reels: #root element not found");
}

createRoot(container).render(<App />);
registerServiceWorker();
