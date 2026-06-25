import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for CloudMind-Zome.
 *
 * If `pnpm exec playwright install chromium` fails in your environment
 * (e.g. slow network), you can run tests against the system browser by setting
 * `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) before `pnpm test:e2e`.
 */
const channel = process.env.PLAYWRIGHT_CHANNEL as "chromium" | "msedge" | "chrome" | undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    ...(channel ? { channel } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(channel ? { channel } : {}) },
    },
  ],
  webServer: {
    command: "node scripts/start-e2e.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
