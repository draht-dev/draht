import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// tokens.css is NOT imported here on purpose: it is linked directly in
// index.html's <head> so it applies before this module even runs
// (spec §16 "no restyle-later debt"). See index.html for the comment.

const container = document.getElementById("root");
if (!container) {
	throw new Error("geist-console: #root element not found");
}

createRoot(container).render(<App />);
