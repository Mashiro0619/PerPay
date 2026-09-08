import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const backend = process.env.PERPAY_DEV_API_URL ?? "http://localhost:6190";

export default defineConfig({
  root,
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "../web-dist/admin",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: 6191,
    strictPort: true,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            const origin = request.headers.origin;
            if (origin === "http://127.0.0.1:6191" || origin === "http://localhost:6191") {
              proxyRequest.setHeader("origin", new URL(backend).origin);
            }
          });
        },
      },
      "/checkout": { target: backend, changeOrigin: true },
      "/assets/app": { target: backend, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
