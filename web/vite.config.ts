import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const WEB_PORT = Number(process.env.WEB_PORT) || 12400;
const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    watch: {
      usePolling: true,
      interval: 300,
      ignored: ["**/node_modules/**", "**/.git/**", "**/dist/**"]
    },
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true
      },
      "/ws": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true
      }
    }
  },
  build: {
    target: "es2020"
  }
});
