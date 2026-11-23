import { defineConfig } from 'vite'
import { handleApiRequest } from './server/api.ts'

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'esnext',
  },
  plugins: [
    {
      name: 'blink-wire-api-relay',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url && req.url.startsWith('/api/')) {
            await handleApiRequest(req, res)
            return
          }
          next()
        })
      },
    },
  ],
})
