import { createServer } from 'node:http'
import { handleApiRequest } from './api.ts'

const port = Number(process.env.RELAY_PORT || 8781)
const server = createServer((req, res) => {
  void handleApiRequest(req, res)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[BlinkWire Relay] listening on http://0.0.0.0:${port}`)
})
