import "./styles.css";
import { mountApp } from "./ui/app.ts";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("App root not found");
}

mountApp(root);
void registerServiceWorker();

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}service-worker.js`);
  } catch {
    // Offline support is a nice-to-have; optical transfer works without it.
  }
}
