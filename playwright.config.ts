import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'pnpm run build && pnpm run start',
		url: `http://127.0.0.1:${PORT}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		env: {
			WHARFINGER_CONFIG: 'config/wharfinger.toml',
			WHARFINGER_DATA_DIR: 'test-results/e2e-data',
			PORT: String(PORT),
			HOST: '127.0.0.1',
			// First-admin bootstrap for specs that drive the admin API.
			WHARFINGER_ADMIN_USERNAME: 'e2e-admin',
			WHARFINGER_ADMIN_PASSWORD: 'e2e-local-secret-99'
		}
	}
});
