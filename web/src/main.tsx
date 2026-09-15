import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initializeTheme } from "./lib/theme.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
initializeTheme();
createRoot(root).render(<App />);
