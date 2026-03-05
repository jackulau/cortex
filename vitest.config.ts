import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
  },
});
