import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Long timeout for infrastructure tests (Cloud SQL + networking can take 20+ min)
		testTimeout: 1_800_000, // 30 minutes
		hookTimeout: 900_000, // 15 minutes for setup/teardown

		// Run tests sequentially to avoid resource conflicts
		pool: 'forks',
		poolOptions: {
			forks: {
				singleFork: true
			}
		},

		// Include integration tests
		include: ['tests/**/*.test.ts'],

		// Reporter for CI visibility
		reporters: ['verbose'],

		// Fail fast on first error
		bail: 1
	}
});
