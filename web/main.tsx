import { createRoot } from "react-dom/client";
import { App } from "./app";
import { applyTheme, savedTheme } from "./theme";

applyTheme(savedTheme());
createRoot(document.getElementById("root")!).render(<App />);
