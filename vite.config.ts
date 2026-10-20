import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Sessions working in worktrees keep them under .claude/ (gitignored): never run their copies of the suite.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT ?? 8787}`,
    },
  },
})
