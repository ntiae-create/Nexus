import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The mobile app talks to an absolute backend URL (`getApiBaseUrl()`), never to a
 * relative path, because the packaged APK has no dev server to proxy through.
 *
 * The proxy below exists only for the browser development experience: it makes
 * `http://<dev-host>:5173/v1/...` reach the local backend, so the web preview works
 * on a phone in the same network without typing an IP into the app.
 */
const backendTarget = process.env.NEXUS_DEV_API_PROXY ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    // Allow the Arena preview host and any LAN address used by a physical device.
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/v1": { target: backendTarget, changeOrigin: true, secure: false },
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
