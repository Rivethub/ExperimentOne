import path from "node:path";
import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const mockIpc = process.env.VITE_MOCK_IPC === "1" || process.env.VITE_MOCK_IPC === "true";
const rootDir = import.meta.dirname;

export default defineConfig({
  // Keep Tauri/Rust tree out of Oxfmt/Oxlint — proto+Vite+ only own the web UI.
  fmt: {
    ignorePatterns: ["src-tauri/**", "dist/**"],
  },
  // Full Oxlint policy lives in `.oxlintrc.json` (warn-only + type-aware).
  lint: {
    ignorePatterns: ["src-tauri/**", "dist/**"],
  },
  test: {
    passWithNoTests: true,
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
      generateScopedName: "[name]_[local]_[hash:6]",
    },
  },
  plugins: lazyPlugins(() => [react({ compiler: true })]),
  clearScreen: false,
  resolve: mockIpc
    ? {
        alias: {
          "@tauri-apps/api/core": path.resolve(rootDir, "src/mock/tauri-core.ts"),
          "@tauri-apps/plugin-dialog": path.resolve(rootDir, "src/mock/tauri-dialog.ts"),
          "@tauri-apps/plugin-shell": path.resolve(rootDir, "src/mock/tauri-shell.ts"),
        },
      }
    : undefined,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host !== undefined && host !== ""
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
