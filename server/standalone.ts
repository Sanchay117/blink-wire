import { createServer } from 'node:http'
import { handleApiRequest } from './api.ts'

const host = process.env.RELAY_HOST || '127.0.0.1'
const port = Number(process.env.RELAY_PORT || 8781)
const server = createServer((req, res) => {
  void handleApiRequest(req, res)
})

server.listen(port, host, () => {
  console.log(`[BlinkWire Relay] listening on http://${host}:${port}`)
})
