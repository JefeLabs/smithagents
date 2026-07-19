import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Flat topology: the front-end sources live at the repo root, so Vite's `root`
// is the project root and there is no `src/` entry directory.
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
