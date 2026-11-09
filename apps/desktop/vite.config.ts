import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;
const mockIpc = process.env.VITE_MOCK_IPC === "1" || process.env.VITE_MOCK_IPC === "true";
const rootDir = import.meta.dirname;

const alias: Record<string, string> = {};
if (mockIpc) {
  alias["@tauri-apps/api/core"] = path.resolve(rootDir, "src/mock/tauri-core.ts");
  alias["@tauri-apps/plugin-dialog"] = path.resolve(rootDir, "src/mock/tauri-dialog.ts");
  alias["@tauri-apps/plugin-shell"] = path.resolve(rootDir, "src/mock/tauri-shell.ts");
}

export default defineConfig({
  // Keep Tauri/Rust tree out of Oxfmt/Oxlint — proto+Vite+ only own the web UI.
  fmt: {
    ignorePatterns: ["src-tauri/**", "dist/**", "src/routeTree.gen.ts"],
  },
  // Full Oxlint policy lives in `.oxlintrc.json` (warn-only + type-aware).
  lint: {
    ignorePatterns: ["src-tauri/**", "dist/**", "src/routeTree.gen.ts"],
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
  plugins: lazyPlugins(() => [
    TanStackRouterVite({
      target: "solid",
      quoteStyle: "double",
      semicolons: true,
    }),
    solid(),
    tailwindcss(),
  ]),
  clearScreen: false,
  resolve: {
    alias,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr:
      host !== undefined && host !== ""
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
