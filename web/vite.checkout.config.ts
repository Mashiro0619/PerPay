import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => ({
  root,
  base: "/assets/checkout/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  publicDir: mode === "server" ? false : "public",
  ssr: { noExternal: true },
  build: {
    outDir:
      mode === "server" ? "../web-dist/checkout-ssr" : "../web-dist/checkout",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    manifest: mode !== "server",
    ssr:
      mode === "server"
        ? fileURLToPath(
            new URL("./src/checkout/entry-server.tsx", import.meta.url),
          )
        : false,
    rollupOptions: {
      input:
        mode === "server"
          ? undefined
          : fileURLToPath(
              new URL("./src/checkout/entry-client.tsx", import.meta.url),
            ),
      output:
        mode === "server"
          ? { format: "cjs", entryFileNames: "renderer.cjs" }
          : undefined,
    },
  },
}));
