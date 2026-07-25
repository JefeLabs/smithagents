import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Control-plane front-end (PRD §5). Conventional layout: sources under src/.
//
// Tauri conventions baked in:
//   - fixed dev port 1420 (must match tauri.conf.json `devUrl`)
//   - clearScreen: false so Rust compiler output stays visible
//   - envPrefix TAURI_ exposes Tauri env vars to the front-end
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    target: "es2021",
    sourcemap: true,
  },
});
