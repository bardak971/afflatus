import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the release the page is built for, as the server is told it (AFFLATUS_VERSION): live.ts holds the two against each other
  define: { __AFFLATUS_VERSION__: JSON.stringify(process.env.AFFLATUS_VERSION?.trim() || "dev") },
  server: {
    port: 8721,
    // the API (and its event stream) is the Afflatus server
    proxy: { "/api": { target: "http://127.0.0.1:8720", changeOrigin: false } },
  },
});
