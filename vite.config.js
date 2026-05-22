import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",           // index.html lives at project root
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: "dist",
  },
});
