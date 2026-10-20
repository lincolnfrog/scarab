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
    // e2e/ is Playwright's (npm run test:egress): a build, a server and a browser, not a unit test.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
