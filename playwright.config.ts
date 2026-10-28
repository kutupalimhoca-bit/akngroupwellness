import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/devices',
  timeout: 60_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'iphone-13-safari', use: { ...devices['iPhone 13'] } },
    { name: 'pixel-7-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'ipad-gen-7', use: { ...devices['iPad (gen 7)'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
});
