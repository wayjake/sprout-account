import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  // bun:sqlite is a Bun builtin — never bundle or pre-transform it
  ssr: {
    external: ["bun:sqlite"],
  },
  optimizeDeps: {
    exclude: ["bun:sqlite"],
  },
});
