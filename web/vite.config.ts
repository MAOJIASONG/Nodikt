import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: {
      usePolling: true,
      interval: 300,
      ignored: ["**/node_modules/**", "**/.git/**", "**/dist/**"]
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true
      }
    }
  },
  build: {
    target: "es2020"
  }
});
