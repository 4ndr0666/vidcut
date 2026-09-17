/* vidcut — local streaming transcode server (main process).
 *
 * Playback fallback for sources the <video> element cannot decode
 * (mkv / avi / ts …): each request carries a source path and a start
 * offset, and the response is a fragmented MP4 piped straight out of
 * an ultrafast ffmpeg re-encode. Every request owns its ffmpeg child,
 * killed the moment the request closes — a new seek is simply a new
 * request, and the old encode dies with its connection.
 *
 * The server binds 127.0.0.1 on an ephemeral port (no fixed-port
 * collisions) and lives until shutdown(): source change or app quit. */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const ffmpeg = require('./ffmpeg')

let server = null
let port = 0
const sockets = new Set()

function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  const source = url.searchParams.get('source')
  const start = Number(url.searchParams.get('startTime')) || 0

  // Local app, but the handler still refuses anything that is not an
  // existing absolute path — the URL surface must not become a probe.
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) {
    response.statusCode = 404
    response.end()
    return
  }

  const proc = ffmpeg.fastCodec(source, start)
  response.writeHead(200, { 'Content-Type': 'video/mp4' })
  proc.stdout.pipe(response)

  // Spawn failures (binary missing) must not take the server down.
  proc.on('error', () => response.destroy())

  request.on('close', () => {
    try { proc.stdout.destroy() } catch (e) { /* already gone */ }
    try { proc.stderr.destroy() } catch (e) { /* already gone */ }
    try { proc.kill() } catch (e) { /* already gone */ }
  })
}

function ensureServer() {
  if (server && server.listening) return Promise.resolve(port)
  return new Promise((resolve, reject) => {
    const pending = http.createServer(handle)
    pending.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    pending.on('error', error => {
      if (pending === server) server = null
      reject(error)
    })
    pending.listen(0, '127.0.0.1', () => {
      server = pending
      port = pending.address().port
      resolve(port)
    })
  })
}

/* Returns { url, duration } — duration is probed once per source and
 * cached; the element's own duration for a fragmented stream is not
 * always finite, so this is the timeline's fallback. */
async function open(source, startTime) {
  if (typeof source !== 'string' || !source) throw new Error('Missing source')
  if (!path.isAbsolute(source)) throw new Error('Source must be an absolute path')
  if (!fs.existsSync(source)) throw new Error('Source not found')

  await ensureServer()
  const info = await ffmpeg.probe(source)
  const url = `http://127.0.0.1:${port}/?source=${encodeURIComponent(source)}` +
    `&startTime=${encodeURIComponent(Number(startTime) || 0)}`
  return { url, duration: info ? info.duration : null }
}

/* Destroy every live connection first — close() alone would wait for
 * long-lived streams that never end on their own. */
function shutdown() {
  if (!server) return
  for (const socket of sockets) {
    try { socket.destroy() } catch (e) { /* already gone */ }
  }
  sockets.clear()
  try { server.close() } catch (e) { /* already closed */ }
  server = null
}

module.exports = { open, shutdown, _internal: { ensureServer, handle } }
