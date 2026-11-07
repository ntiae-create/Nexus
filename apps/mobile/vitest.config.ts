import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Mobile tests run in a DOM environment (happy-dom) so React screens can be
 * exercised, while `@capacitor/core` is stubbed per test: no real device, no real
 * backend and no production call is involved.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
  },
});
