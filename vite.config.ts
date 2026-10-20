import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT ?? 8787}`,
    },
  },
  test: {
    // e2e/ and verifier/e2e/ are Playwright's (npm run test:egress, test:verifier): a build, a server and a browser, not a unit test.
    // Sessions working in worktrees keep them under .claude/ (gitignored): never run their copies of the suite.
    exclude: [...configDefaults.exclude, 'e2e/**', 'verifier/e2e/**', '.claude/**'],
  },
})
