import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { include: ["tests/**/*.test.ts"] },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
});
