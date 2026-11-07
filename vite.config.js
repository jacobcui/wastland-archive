import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5177,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:5178", changeOrigin: true },
      "/media": { target: "http://127.0.0.1:5178", changeOrigin: true },
      "/vendor": { target: "http://127.0.0.1:5178", changeOrigin: true },
      "/backgrounds": { target: "http://127.0.0.1:5178", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    target: ["es2022", "chrome110", "edge110", "safari16", "firefox115"],
  },
});
