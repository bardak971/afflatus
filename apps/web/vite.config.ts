import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8721,
    // the API (and its event stream) is the studai server
    proxy: { "/api": { target: "http://127.0.0.1:8720", changeOrigin: false } },
  },
});
