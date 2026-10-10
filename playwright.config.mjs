import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3000', headless: true },
  webServer: {
    command: 'node tests/mock-server.mjs',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '3000',
      PAYPAL_CLIENT_ID: 'test-client-id',
      PAYPAL_CLIENT_SECRET: 'test-client-secret',
      PAYPAL_ENV: 'sandbox',
      GEMINI_API_KEY2: ''
    }
  }
});
