// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [
    ["list"],
    ["github"],
    ["junit", { outputFile: "test-results/playwright.xml" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ] : "list",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
