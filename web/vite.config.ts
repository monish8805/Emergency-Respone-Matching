import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // The react plugin must come after Start's plugin.
  plugins: [tanstackStart(), nitro(), viteReact()],
});
