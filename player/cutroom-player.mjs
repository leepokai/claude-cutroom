#!/usr/bin/env node
// Cutroom live player: plays a HyperFrames composition in headless Chrome and
// serves its frames over a tiny localhost HTTP API, so the Cutroom pane can
// show the video *moving* inside Claude Code (desktop app: Svg; terminal:
// half-block cells). Node 22+, no dependencies: CDP over the global WebSocket.
//
//   node cutroom-player.mjs '{"project":"/abs/proj","hf":["node","/…/plugin-cli.mjs"],"width":854,"height":480}'
//
// stdout, one JSON line once ready:  {"port":51234,"duration":45}
// GET  /frame?since=<seq>[&rgb=<w>]  → {seq,t,d,paused,jpeg?,rgb?,rgbW?,rgbH?}  (jpeg/rgb only when newer than since)
// POST /cmd {op:"play"|"pause"|"toggle"|"seek"|"reload"|"save", t?, path?}
// Everything it starts dies with it; it exits when its parent does.

import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const cfg = JSON.parse(process.argv[2] ?? '{}')
const W = cfg.width ?? 854
const H = cfg.height ?? 480
let QUALITY = cfg.quality ?? 72 // lowered on the fly when a frame would outgrow the pane's Svg cap
const children = []
let shuttingDown = false

const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => process.stderr.write(`[cutroom-player] ${a.join(' ')}\n`)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(150)
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM') // the whole group: npx → node → hyperframes, chrome → its helpers
    } catch {
      try {
        c.kill('SIGTERM')
      } catch {}
    }
  }
  setTimeout(() => process.exit(code), 300)
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0))
process.on('uncaughtException', err => {
  log('fatal', err?.stack ?? err)
  process.stdout.write(`${JSON.stringify({ error: String(err?.message ?? err) })}\n`)
  shutdown(1)
})
// exit with the parent (the Claude Code session), so nothing is left running
const parent = process.ppid
if (cfg.watchParent !== false) setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    shutdown(0)
  }
}, 2000).unref()

// ---------- 1. the HyperFrames player server ----------

const playPort = await freePort()
const hf = cfg.hf ?? ['npx', '--yes', 'hyperframes']
const play = spawn(hf[0], [...hf.slice(1), 'play', '--no-open', '--port', String(playPort)], {
  cwd: cfg.project,
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', HYPERFRAMES_NO_UPDATE_CHECK: '1' },
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
children.push(play)
play.stderr.on('data', d => log('play:', String(d).trim().slice(0, 300)))
play.on('exit', code => !shuttingDown && (log('play server exited', code), shutdown(1)))
const playUrl = `http://127.0.0.1:${playPort}/`
await waitFor(async () => (await fetch(playUrl)).ok, 90_000, 'hyperframes play')

// ---------- 2. headless Chrome ----------

const chromePath =
  cfg.chrome ??
  (await new Promise((resolve, reject) =>
    execFile(hf[0], [...hf.slice(1), 'browser', 'path'], { env: { ...process.env, NO_COLOR: '1' } }, (err, out) =>
      err ? reject(err) : resolve(String(out).trim().split('\n').pop()),
    ),
  ))
const profile = await mkdtemp(path.join(os.tmpdir(), 'cutroom-chrome-'))
const chrome = spawn(
  chromePath,
  [
    '--headless',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
)
children.push(chrome)
chrome.on('exit', () => {
  void rm(profile, { recursive: true, force: true })
  if (!shuttingDown) shutdown(1)
})
const devtools = await waitFor(
  async () => (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
  30_000,
  'Chrome DevTools port',
)
const targets = await waitFor(
  async () => (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()).filter(t => t.type === 'page'),
  15_000,
  'a Chrome page',
)

// ---------- 3. CDP ----------

const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let nextId = 1
const pending = new Map()
const listeners = new Map()
ws.onmessage = ev => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p?.reject(new Error(msg.error.message))
    else p?.resolve(msg.result)
  } else if (msg.method) {
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
  }
}
ws.onclose = () => !shuttingDown && shutdown(1)
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const onEvent = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn])
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result?.value
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })

const PLAYER = `document.querySelector('hyperframes-player')`
async function load() {
  const loaded = new Promise(r => onEvent('Page.loadEventFired', r))
  await cdp('Page.navigate', { url: playUrl })
  await loaded
  // the bare player, edge to edge, no built-in controls (the pane has its own)
  await evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent = 'body{padding:0!important;background:#000!important}.player-wrap{max-width:none!important;width:100vw!important;height:100vh!important;aspect-ratio:auto!important;border-radius:0!important}.info{display:none!important}';
    document.head.appendChild(s);
    ${PLAYER}?.removeAttribute('controls');
  })()`)
  await waitFor(() => evaluate(`!!${PLAYER} && ${PLAYER}.ready && ${PLAYER}.duration > 0`), 60_000, 'the composition to load')
}
await load()

// ---------- 4. frames ----------

let frame = { seq: 0, jpeg: null }
const MAX_JPEG = 110_000 // base64 chars; the desktop Svg that shows a frame holds 131072
onEvent('Page.screencastFrame', p => {
  frame = { seq: frame.seq + 1, jpeg: p.data }
  void cdp('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  if (p.data.length > MAX_JPEG && QUALITY > 35) {
    // real footage compresses worse than flat graphics: step the quality down and restart the cast
    QUALITY -= 10
    void cdp('Page.stopScreencast').then(startScreencast).catch(() => {})
  }
})
const startScreencast = () =>
  cdp('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
await startScreencast()
// a paused page sends no new frame: nudge it so the first one is the styled player
await evaluate(`(async () => { const p = ${PLAYER}; const t = p.currentTime || 0; await p.seek(t + 0.04); await p.seek(t) })()`).catch(() => {})

const playerState = () => evaluate(`(() => { const p = ${PLAYER}; return p ? { t: p.currentTime, d: p.duration, paused: p.paused } : null })()`)

// downscale a jpeg to raw rgb inside Chrome (no image decoder in Node's stdlib)
async function toRgb(jpeg, w) {
  return evaluate(`(async () => {
    const blob = await (await fetch('data:image/jpeg;base64,${jpeg}')).blob();
    const bmp = await createImageBitmap(blob);
    const w = ${w}, h = Math.max(1, Math.round(w * bmp.height / bmp.width));
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h * 3);
    for (let i = 0, o = 0; i < px.length; i += 4) { out[o++] = px[i]; out[o++] = px[i + 1]; out[o++] = px[i + 2]; }
    let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return { rgb: btoa(s), w, h };
  })()`)
}

async function command(cmd) {
  switch (cmd.op) {
    case 'play':
      await evaluate(`${PLAYER}.play()`)
      break
    case 'pause':
      await evaluate(`${PLAYER}.pause()`)
      break
    case 'toggle':
      await evaluate(`(() => { const p = ${PLAYER}; p.paused ? p.play() : p.pause() })()`)
      break
    case 'seek':
      await evaluate(`${PLAYER}.seek(${Number(cmd.t) || 0})`)
      break
    case 'reload': {
      const s = await playerState()
      await load()
      if (s) await evaluate(`${PLAYER}.seek(${s.t})`)
      break
    }
    case 'save':
      if (!frame.jpeg || typeof cmd.path !== 'string') throw new Error('no frame yet')
      await mkdir(path.dirname(cmd.path), { recursive: true })
      await writeFile(cmd.path, Buffer.from(frame.jpeg, 'base64'))
      break
    case 'strip': {
      // n small frames spread over the timeline, for the clip thumbnails; the player is left where it was
      const s = await playerState()
      const n = Math.max(1, Math.min(24, Number(cmd.n) || 12))
      const w = Math.max(48, Math.min(320, Number(cmd.w) || 160))
      const d = s?.d ?? 0
      await evaluate(`${PLAYER}.pause()`)
      const frames = []
      for (let i = 0; i < n; i++) {
        await evaluate(`${PLAYER}.seek(${((i + 0.5) * d) / n})`)
        await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: W, height: H, scale: w / W } })
        frames.push(shot.data)
      }
      await evaluate(`${PLAYER}.seek(${s?.t ?? 0})`)
      return { ...(await playerState()), frames }
    }
    default:
      throw new Error(`unknown op ${cmd.op}`)
  }
  return playerState()
}

// ---------- 5. HTTP ----------

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/frame') {
      const since = Number(url.searchParams.get('since') ?? -1)
      const s = (await playerState()) ?? { t: 0, d: 0, paused: true }
      const out = { seq: frame.seq, ...s }
      if (frame.seq > since && frame.jpeg) {
        out.jpeg = frame.jpeg
        const rgbW = Number(url.searchParams.get('rgb') ?? 0)
        if (rgbW > 0) {
          const r = await toRgb(frame.jpeg, Math.min(512, rgbW))
          Object.assign(out, { rgb: r.rgb, rgbW: r.w, rgbH: r.h })
        }
      }
      return send(200, out)
    }
    if (req.method === 'GET' && url.pathname === '/cmd') {
      // the same commands as a query string, for hosts whose fetch sends no body
      const cmd = Object.fromEntries(url.searchParams)
      for (const k of ['t', 'n', 'w']) if (k in cmd) cmd[k] = Number(cmd[k])
      return send(200, { ok: true, state: await command(cmd) })
    }
    if (req.method === 'POST' && url.pathname === '/cmd') {
      let body = ''
      for await (const chunk of req) body += chunk
      return send(200, { ok: true, state: await command(JSON.parse(body || '{}')) })
    }
    send(404, { error: 'not found' })
  } catch (err) {
    send(500, { error: String(err?.message ?? err) })
  }
})
server.listen(0, '127.0.0.1', async () => {
  const s = await playerState()
  process.stdout.write(`${JSON.stringify({ port: server.address().port, duration: s?.d ?? 0 })}\n`)
})
