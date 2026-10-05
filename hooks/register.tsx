import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HfClip, HfPreview, HfSelection, HfStudio, HfTimeline } from '../types'

// Cutroom: a cutting-room pane for HyperFrames projects.
//
// The picture lives in three places at once: HyperFrames Studio in the browser
// (full fidelity), a *live player* in this pane (player/cutroom-player.mjs plays
// the composition in headless Chrome and streams its frames: an Svg on the
// desktop app, kitty pixels or half-block cells in a terminal), and a snapshot
// path Claude can read. Studio's selection and
// time are polled into the pane and attached to every prompt the person types,
// so "make this bigger" needs no further pointing. Cuts are the HyperFrames
// CLI's own `timeline` verbs; everything else goes to Claude.

const PANE = 'cutroom'
const WORK = '.hyperframes/cutroom'
const RGB_W = 192 // width of the raw strip the terminal thumbnail is built from
const LIVE_W = 854 // the live player's viewport
const LIVE_H = 480

const project = atom({ plugin: 'cutroom', key: 'project' } as const, null as string | null)
const candidates = atom({ plugin: 'cutroom', key: 'candidates' } as const, [] as string[])
const timeline = atom({ plugin: 'cutroom', key: 'timeline' } as const, null as HfTimeline)
const selected = atom({ plugin: 'cutroom', key: 'selected' } as const, null as string | null)
const playhead = atom({ plugin: 'cutroom', key: 'playhead' } as const, 0)
const preview = atom({ plugin: 'cutroom', key: 'preview' } as const, null as HfPreview)
const studio = atom({ plugin: 'cutroom', key: 'studio' } as const, null as HfStudio)
const selection = atom({ plugin: 'cutroom', key: 'selection' } as const, null as HfSelection)
const status = atom({ plugin: 'cutroom', key: 'status' } as const, '')
const busy = atom({ plugin: 'cutroom', key: 'busy' } as const, '')
const receipts = atom({ plugin: 'cutroom', key: 'receipts' } as const, [] as string[])
const autoContext = atom({ plugin: 'cutroom', key: 'autoContext' } as const, true)
const live = atom({ plugin: 'cutroom', key: 'live' } as const, null as { port: number; duration: number } | null)

type Eng = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const fmt = (n: number) => String(Math.round(n * 100) / 100)
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const tail = (s: string, n = 200) => s.trim().slice(-n)
const say = ($: Eng, text: string) => update($, status, () => text)
const working = ($: Eng, text: string) => update($, busy, () => text)
// background work outlives a hot reload or a test; its late writes are refused and dropped
const quiet = () => undefined

// ---------- HyperFrames CLI ----------

let hfArgv: string[] | undefined
async function hf($: Eng): Promise<string[]> {
  if (hfArgv) return hfArgv
  const home = (await $.env.get('HOME')) ?? ''
  const cache = `${home}/.claude/plugins/cache/hyperframes/hyperframes`
  const versions = (await $.fs.list(cache).catch(() => []))
    .filter(e => e.kind === 'dir')
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    const launcher = `${cache}/${v}/skills/hyperframes/scripts/plugin-cli.mjs`
    if (await $.fs.exists(launcher)) return (hfArgv = ['node', launcher])
  }
  // ponytail: no plugin cache → npx (slower first run); add a userConfig path if it ever matters
  return (hfArgv = ['npx', '--yes', 'hyperframes'])
}

async function run($: Eng, dir: string, args: string[], timeoutMs = 120_000) {
  const argv = [...(await hf($)), ...args]
  return $.process.run(argv, {
    cwd: dir,
    timeoutMs,
    env: { HYPERFRAMES_NO_UPDATE_CHECK: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  })
}

function json(text: string): Json {
  const i = text.indexOf('{')
  if (i < 0) return null
  try {
    return JSON.parse(text.slice(i))
  } catch {
    return null
  }
}

// ---------- project ----------

async function isProject($: Eng, dir: string) {
  return (await $.fs.exists(`${dir}/hyperframes.json`)) || (await $.fs.exists(`${dir}/index.html`))
}

async function findProjects($: Eng, cwd: string): Promise<string[]> {
  const found: string[] = []
  const has = (d: string) => $.fs.exists(`${d}/hyperframes.json`)
  const kids = async (d: string) =>
    (await $.fs.list(d).catch(() => []))
      .filter(e => e.kind === 'dir' && !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 200)
      .map(e => `${d}/${e.name}`)
  if (await has(cwd)) found.push(cwd)
  for (const a of await kids(cwd)) {
    if (await has(a)) {
      found.push(a)
      continue
    }
    for (const b of await kids(a)) if (await has(b)) found.push(b)
  }
  return found
}

async function openProject($: Eng, dir: string, openBrowser: boolean) {
  const clean = dir.replace(/\/+$/, '')
  if (!(await isProject($, clean))) return say($, `not a HyperFrames project: ${clean}`)
  stopLive()
  await update($, live, () => null)
  await update($, project, () => clean)
  await update($, selected, () => null)
  await update($, preview, () => null)
  await update($, studio, () => null)
  await update($, selection, () => null)
  await update($, receipts, () => [])
  await update($, playhead, () => 0)
  await $.store.set(`last:${await $.session.cwd()}`, clean)
  await say($, `opened ${base(clean)}`)
  await loadTimeline($, clean)
  await ensureStudio($, clean, openBrowser)
  void capture($, clean, 0).catch(quiet) // a poster frame while the live player starts
  void startLive($, clean).catch(quiet)
}

// ---------- timeline ----------

async function loadTimeline($: Eng, dir: string) {
  const r = await run($, dir, ['timeline', '--json'])
  const j = json(r.stdout)
  if (!j?.timeline) return say($, `timeline: ${tail(r.stderr || r.stdout) || 'no output'}`)
  const clips: HfClip[] = []
  for (const track of j.timeline.tracks ?? []) {
    for (const row of track.rows ?? []) {
      if (row.nested) continue
      clips.push({
        id: String(row.id),
        ref: String(row.ref ?? `#${row.id}`),
        file: String(row.file ?? 'index.html'),
        trackKind: String(row.trackKind ?? track.kind ?? 'graphics'),
        absStart: Number(row.absStart ?? 0),
        absEnd: Number(row.absEnd ?? 0),
        src: row.src ? String(row.src) : null,
        children: Array.isArray(row.children) ? row.children.length : 0,
      })
    }
  }
  await update($, timeline, () => ({ duration: Number(j.timeline.duration ?? 0), clips }))
}

async function refresh($: Eng, dir: string) {
  await loadTimeline($, dir)
  if (!(await liveCmd($, { op: 'reload' }))) void capture($, dir, await read($, playhead)).catch(quiet)
}

// ---------- Studio: server, browser, live selection ----------

let pollTimer: { cancel: () => void } | undefined
let pollFailures = 0
let lastSelectionAt: string | null | undefined

const studioOf = (st: Json): HfStudio =>
  st?.result?.state === 'running' && st.result.serverUrl
    ? {
        serverUrl: String(st.result.serverUrl),
        studioUrl: String(st.result.studioUrl ?? `${st.result.serverUrl}/`).replace('127.0.0.1', 'localhost'),
        projectName: String(st.result.projectName ?? ''),
      }
    : null

async function ensureStudio($: Eng, dir: string, openBrowser: boolean) {
  let srv = studioOf(json((await run($, dir, ['preview', '--status', '--json'])).stdout))
  if (!srv) {
    await working($, 'starting Studio…')
    const r = await run($, dir, ['preview', '--background', ...(openBrowser ? [] : ['--no-open'])], 90_000)
    srv = studioOf(json((await run($, dir, ['preview', '--status', '--json'])).stdout))
    await working($, '')
    if (!srv) return say($, `Studio did not start: ${tail(r.stderr || r.stdout)}`)
  } else if (openBrowser) {
    await openUrl($, srv.studioUrl)
  }
  await update($, studio, () => srv)
  startPolling($, dir)
}

async function openUrl($: Eng, url: string) {
  const mac = await $.process.run(['open', url]).catch(() => ({ exitCode: 1 }))
  if (mac.exitCode !== 0) await $.process.run(['xdg-open', url]).catch(() => undefined)
}

function startPolling($: Eng, dir: string) {
  pollTimer?.cancel()
  pollFailures = 0
  lastSelectionAt = undefined
  pollTimer = $.clock.every(1500, () => void pollSelection($, dir).catch(quiet))
}

async function pollSelection($: Eng, dir: string) {
  const srv = await read($, studio)
  if (!srv) return pollTimer?.cancel()
  const url = `${srv.serverUrl}/api/projects/${encodeURIComponent(srv.projectName)}/selection`
  const r = await $.http.fetch(url).catch(() => null)
  if (!r?.ok) {
    if (++pollFailures >= 3) {
      pollTimer?.cancel()
      await update($, studio, () => null)
      await say($, 'Studio stopped — press Open Studio to start it again')
    }
    return
  }
  pollFailures = 0
  const j = json(r.text)
  const updatedAt: string | null = j?.updatedAt ?? null
  if (updatedAt === lastSelectionAt) return
  lastSelectionAt = updatedAt
  const s = j?.selection
  if (!s) return update($, selection, () => null)
  const sel: HfSelection = {
    id: s.target?.id ?? null,
    hfId: s.target?.hfId ?? null,
    selector: s.target?.selector ?? null,
    file: s.sourceFile ?? s.compositionPath ?? null,
    label: s.label ?? null,
    text: typeof s.textContent === 'string' ? s.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    time: typeof s.currentTime === 'number' ? s.currentTime : null,
    updatedAt,
  }
  await update($, selection, () => sel)
  const tl = await read($, timeline)
  const clip = tl?.clips.find(c => c.id === sel.id) ?? tl?.clips.find(c => sel.file !== null && c.src === sel.file)
  if (clip) await update($, selected, () => clip.id)
  if (sel.time !== null) await seek($, dir, sel.time)
  await say($, `Studio: ${sel.label ?? sel.id ?? sel.selector ?? 'selection'}`)
}

// ---------- frame preview ----------

function pngSize(b64: string) {
  const head = atob(b64.slice(0, 32))
  const u32 = (o: number) =>
    ((head.charCodeAt(o) << 24) >>> 0) + (head.charCodeAt(o + 1) << 16) + (head.charCodeAt(o + 2) << 8) + head.charCodeAt(o + 3)
  return { width: u32(16) || 16, height: u32(20) || 9 }
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000))
  return btoa(s)
}

/** Half-block cells (▀: top pixel as foreground, bottom pixel as background) box-averaged from the raw rgb strip. */
function rasterCells(rgb: Uint8Array, srcW: number, srcH: number, cols: number, rows: number): string {
  const out = new Uint8Array(cols * rows * 12)
  const dv = new DataView(out.buffer)
  const pxH = rows * 2
  const sample = (px: number, py: number) => {
    const x0 = Math.floor((px * srcW) / cols)
    const x1 = Math.max(x0 + 1, Math.floor(((px + 1) * srcW) / cols))
    const y0 = Math.floor((py * srcH) / pxH)
    const y1 = Math.max(y0 + 1, Math.floor(((py + 1) * srcH) / pxH))
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let y = y0; y < y1 && y < srcH; y++) {
      for (let x = x0; x < x1 && x < srcW; x++) {
        const i = (y * srcW + x) * 3
        r += rgb[i] ?? 0
        g += rgb[i + 1] ?? 0
        b += rgb[i + 2] ?? 0
        n++
      }
    }
    if (n === 0) return 0
    // ponytail: 5 bits per channel keeps distinct colour pairs under the terminal's palette; dither if banding shows
    const q = (v: number) => Math.round(v / n) & 0xf8
    return ((q(r) << 16) | (q(g) << 8) | q(b)) >>> 0
  }
  let o = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      dv.setUint32(o, 0x2580, true)
      dv.setUint32(o + 4, sample(col, row * 2), true)
      dv.setUint32(o + 8, sample(col, row * 2 + 1), true)
      o += 12
    }
  }
  return toB64(out)
}

let captureSeq = 0
let captureTimer: { cancel: () => void } | undefined

function scheduleCapture($: Eng, dir: string, at: number) {
  captureTimer?.cancel()
  captureTimer = $.clock.after(500, () => void capture($, dir, at).catch(quiet))
}

/** Grabs the frame at `at`: Studio's thumbnail API when the server runs (~0.5 s), else `hyperframes snapshot` (~4 s). */
async function grabFrame($: Eng, dir: string, at: number, out: string): Promise<string | null> {
  const srv = await read($, studio)
  const full = `${out}/frame.png`
  if (srv) {
    const url = `${srv.serverUrl}/api/projects/${encodeURIComponent(srv.projectName)}/thumbnail/index.html?t=${fmt(at)}&format=png&output=source`
    const r = await $.process.run(['curl', '-sf', '--max-time', '20', '-o', full, url], { timeoutMs: 25_000 }).catch(() => ({ exitCode: 1 }))
    if (r.exitCode === 0) return full
  }
  const r = await run($, dir, ['snapshot', '--at', fmt(at), '--no-end', '--describe', 'false', '-o', out])
  const frames = (await $.fs.list(out).catch(() => []))
    .filter(f => /^frame-\d+-at-.*\.png$/.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const frame = frames[0]
  if (!frame) {
    await say($, `snapshot failed: ${tail(r.stderr || r.stdout)}`)
    return null
  }
  await $.process.run(['mv', '-f', `${out}/${frame.name}`, full]).catch(() => undefined)
  return full
}

async function capture($: Eng, dir: string, at: number) {
  const seq = ++captureSeq
  const out = `${dir}/${WORK}`
  await working($, `frame @ ${fmt(at)}s…`)
  const full = await grabFrame($, dir, at, out)
  if (seq !== captureSeq) return // a later seek superseded this one
  if (!full) return working($, '')
  const png = `${out}/preview.png`
  const jpg = `${out}/preview.jpg`
  const rgb = `${out}/preview.rgb`
  const ff = await $.process.run(
    ['ffmpeg', '-y', '-loglevel', 'error', '-i', full,
      '-vf', 'scale=960:-2', png,
      '-vf', 'scale=480:-2', '-q:v', '6', jpg,
      '-vf', `scale=${RGB_W}:-1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgb],
    { timeoutMs: 30_000 },
  )
  if (ff.exitCode !== 0) {
    await working($, '')
    return say($, `ffmpeg: ${tail(ff.stderr)}`)
  }
  await update($, preview, () => ({ at, png, jpg, rgb, rgbW: RGB_W, gen: seq }))
  await working($, '')
}

const fileCache = new Map<string, { gen: number; base64: string }>()
async function cachedBase64($: Eng, path: string, gen: number) {
  const hit = fileCache.get(path)
  if (hit && hit.gen === gen) return hit.base64
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  fileCache.set(path, { gen, base64 })
  return base64
}

// ---------- live player ----------

type LiveFrame = { seq: number; jpeg: string; rgb: string | null; rgbW: number; rgbH: number }
let liveStream: AsyncGenerator<unknown, unknown> | undefined
let livePort = 0
let liveSeq = -1
let liveFrame: LiveFrame | null = null
let liveT = 0
let livePaused = true
let liveTimer: { cancel: () => void } | undefined
let liveInflight = false
let rgbWant = 0 // the terminal draws from raw rgb this wide; 0 = jpeg only (desktop)

function stopLive() {
  liveTimer?.cancel()
  liveTimer = undefined
  const stream = liveStream
  liveStream = undefined
  void stream?.return(undefined) // leaving the loop kills the helper, which kills Chrome and the play server
  livePort = 0
  liveSeq = -1
  liveFrame = null
  livePaused = true
}

async function startLive($: Eng, dir: string) {
  stopLive()
  const config = { project: dir, hf: await hf($), width: LIVE_W, height: LIVE_H }
  const stream = $.process.spawn({ argv: ['node', `${$.plugin.root}/player/cutroom-player.mjs`, JSON.stringify(config)], cwd: dir })
  liveStream = stream
  await working($, 'starting the live player…')
  let head = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        $.ui.log(text.trim().slice(0, 300), { to: 'debug' })
        continue
      }
      if (livePort) continue
      head += text
      const nl = head.indexOf('\n')
      if (nl < 0) continue
      const first = json(head.slice(0, nl))
      await working($, '')
      if (!first?.port) {
        await say($, `live player failed: ${first?.error ?? head.slice(0, 200)} — frames fall back to stills`)
        continue
      }
      livePort = Number(first.port)
      await update($, live, () => ({ port: livePort, duration: Number(first.duration ?? 0) }))
      await liveCmd($, { op: 'seek', t: await read($, playhead) })
      liveTimer = $.clock.every(100, () => void pollLive($).catch(quiet))
    }
  } catch (err) {
    if (liveStream === stream) await say($, `live player stopped: ${String(err).slice(0, 200)}`)
  }
  if (liveStream === stream) {
    stopLive()
    await update($, live, () => null)
    await working($, '')
  }
}

async function liveCmd($: Eng, cmd: { op: string; t?: number; path?: string }): Promise<boolean> {
  if (!livePort) return false
  const r = await $.http
    .fetch(`http://127.0.0.1:${livePort}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) })
    .catch(() => null)
  return Boolean(r?.ok)
}

async function pollLive($: Eng) {
  if (!livePort || liveInflight) return
  liveInflight = true
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${livePort}/frame?since=${liveSeq}${rgbWant ? `&rgb=${rgbWant}` : ''}`).catch(() => null)
    const j = r?.ok ? json(r.text) : null
    if (!j) return
    const wasPaused = livePaused
    const t = Math.round(Number(j.t ?? 0) * 1000) / 1000
    const moved = t !== liveT
    livePaused = Boolean(j.paused)
    liveT = t
    if (typeof j.jpeg === 'string') {
      liveSeq = Number(j.seq)
      liveFrame = { seq: liveSeq, jpeg: j.jpeg, rgb: typeof j.rgb === 'string' ? j.rgb : null, rgbW: Number(j.rgbW ?? 0), rgbH: Number(j.rgbH ?? 0) }
      $.ui.invalidate('ui.render')
    } else if (moved || wasPaused !== livePaused) $.ui.invalidate('ui.render')
    if (livePaused && (moved || !wasPaused)) await update($, playhead, () => t)
  } finally {
    liveInflight = false
  }
}

async function togglePlay($: Eng) {
  if (!(await liveCmd($, { op: 'toggle' }))) await say($, 'the live player is not running — /cut starts it')
}

function rgbToRgba(rgb: Uint8Array): string {
  const out = new Uint8Array((rgb.length / 3) * 4)
  for (let i = 0, o = 0; i < rgb.length; i += 3) {
    out[o++] = rgb[i] ?? 0
    out[o++] = rgb[i + 1] ?? 0
    out[o++] = rgb[i + 2] ?? 0
    out[o++] = 255
  }
  return toB64(out)
}

// ---------- edits (the CLI's own timeline mutations) ----------

async function seek($: Eng, dir: string, to: number) {
  const tl = await read($, timeline)
  const max = tl?.duration ?? Number.POSITIVE_INFINITY
  const at = Math.max(0, Math.min(max, Math.round(to * 1000) / 1000))
  await update($, playhead, () => at)
  if (!(await liveCmd($, { op: 'seek', t: at }))) scheduleCapture($, dir, at)
}

async function selectClip($: Eng, dir: string, clip: HfClip) {
  await update($, selected, () => clip.id)
  const t = await read($, playhead)
  if (t < clip.absStart || t >= clip.absEnd) await seek($, dir, clip.absStart)
}

async function edit($: Eng, dir: string, label: string, args: string[]) {
  await working($, `${label}…`)
  const r = await run($, dir, ['timeline', ...args, '--json'])
  const j = json(r.stdout)
  await working($, '')
  if (!j?.ok) {
    const why = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '')
    return say($, `${label} failed: ${why || tail(r.stderr || r.stdout)}`)
  }
  if (j.receipt && typeof j.receipt === 'object' && !Array.isArray(j.receipt)) {
    const path = `${dir}/${WORK}/receipt-${await $.clock.now()}.json`
    await $.fs.write(path, JSON.stringify(j.receipt))
    await update($, receipts, list => [...list, path].slice(-30))
  }
  await say($, `${label} ✓`)
  await refresh($, dir)
}

async function withClip($: Eng, fn: (clip: HfClip, t: number) => Promise<void>) {
  const [tl, sel, t] = await Promise.all([read($, timeline), read($, selected), read($, playhead)])
  const clip = tl?.clips.find(c => c.id === sel)
  if (!clip) return say($, 'select a clip first (click it in Studio, or press its row or number here)')
  await fn(clip, t)
}

const inside = (clip: HfClip, t: number) => t > clip.absStart && t < clip.absEnd

async function undoLast($: Eng, dir: string) {
  const list = await read($, receipts)
  const last = list[list.length - 1]
  if (!last) return say($, 'nothing to undo here (Studio has its own Undo for edits made there)')
  await working($, 'undo…')
  const r = await run($, dir, ['timeline', 'undo', last, '--json'])
  const j = json(r.stdout)
  await working($, '')
  if (!j?.ok) return say($, `undo failed: ${j?.error?.message ?? tail(r.stderr || r.stdout)}`)
  await update($, receipts, l => l.slice(0, -1))
  await say($, 'undo ✓')
  await refresh($, dir)
}

// ---------- check / render ----------

async function check($: Eng, dir: string) {
  await working($, 'check… (lint + runtime + layout + contrast)')
  const r = await run($, dir, ['check', '--json'], 300_000).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  await working($, '')
  const j = json(r.stdout)
  const issues: Json[] = Array.isArray(j?.issues) ? j.issues : Array.isArray(j?.findings) ? j.findings : []
  const errors = issues.filter(i => i?.severity === 'error').length
  const counts = issues.length ? ` · ${errors} error(s), ${issues.length - errors} other finding(s)` : ''
  await say($, r.exitCode === 0 ? `check passed${counts}` : `check failed (exit ${r.exitCode})${counts} — ask Claude: "fix the check findings"`)
}

async function renderDraft($: Eng, dir: string) {
  const out = 'renders/draft.mp4'
  await working($, 'rendering draft → renders/draft.mp4 (can take minutes)…')
  const r = await run($, dir, ['render', '--quality', 'draft', '--quiet', '-o', out], 600_000).catch(err => ({
    exitCode: 1,
    stdout: '',
    stderr: String(err),
  }))
  await working($, '')
  if (r.exitCode !== 0) return say($, `render failed (exit ${r.exitCode}): ${tail(r.stderr || r.stdout)}`)
  await say($, `rendered ${dir}/${out}`)
  $.ui.toast(`Cutroom: draft rendered → ${out}`)
}

// ---------- what Claude is told ----------

let pendingRefresh = false

async function contextBlock($: Eng, dir: string): Promise<string> {
  const [t, tl, selId, sel, pv, srv] = await Promise.all([
    read($, playhead),
    read($, timeline),
    read($, selected),
    read($, selection),
    read($, preview),
    read($, studio),
  ])
  const clip = tl?.clips.find(c => c.id === selId)
  const lines: string[] = [
    `[Cutroom] The person is editing the HyperFrames project at ${dir}${srv ? ` with Studio open at ${srv.studioUrl}` : ''}.`,
  ]
  if (sel) {
    lines.push(
      `Studio selection ("this" / 這個 / 這段 means it): ${sel.label ?? ''} ${sel.selector ?? ''}${sel.hfId ? ` data-hf-id=${sel.hfId}` : ''}${sel.file ? ` in ${sel.file}` : ''}${sel.text ? ` — text "${sel.text}"` : ''}`.replace(/\s+/g, ' '),
    )
  }
  if (clip) {
    lines.push(
      `Selected clip: ${clip.id} on the ${clip.trackKind} track, ${fmt(clip.absStart)}–${fmt(clip.absEnd)}s, declared in ${clip.file}${clip.src ? ` (src ${clip.src})` : ''}.`,
    )
  } else if (!sel) lines.push('Nothing is selected.')
  const still = `${dir}/${WORK}/live.jpg`
  const shot = (await liveCmd($, { op: 'save', path: still })) ? still : pv?.png
  lines.push(`Playhead: ${fmt(livePort && !livePaused ? liveT : t)}s.${shot ? ` A snapshot of that frame is at ${shot} (Read it to see the picture).` : ''}`)
  if (tl) {
    lines.push(
      `Timeline (${fmt(tl.duration)}s): ${tl.clips.map(c => `${c.id} [${c.trackKind}] ${fmt(c.absStart)}–${fmt(c.absEnd)}${c.src ? ` ${c.src}` : ''}`).join('; ')}`,
    )
  }
  lines.push(
    'Before editing composition files load the hyperframes skill (and hyperframes-core; hyperframes-keyframes for motion, hyperframes-audio for sound). Use `hyperframes timeline <verb>` for cuts and `hyperframes snapshot --at <t>` to look at any other frame. Change only what the person named, run `hyperframes lint` afterwards, and keep the reply to one or two sentences. Studio reloads by itself.',
  )
  return lines.join('\n')
}

async function askClaude($: Eng, dir: string, request: string) {
  pendingRefresh = true
  await say($, `sent to Claude: ${request.slice(0, 70)}`)
  void $.prompt.submit({ text: `${request}\n\n${await contextBlock($, dir)}` })
}

// ---------- drawing helpers ----------

function bar(width: number, duration: number, s: number, e: number, t: number) {
  const d = duration > 0 ? duration : 1
  const cells: string[] = []
  for (let i = 0; i < width; i++) {
    const a = (i / width) * d
    const b = ((i + 1) / width) * d
    cells.push(e > a && s < b ? '█' : '·')
  }
  const p = Math.min(width - 1, Math.max(0, Math.floor((t / d) * width)))
  cells[p] = '┃'
  return cells.join('')
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const TRACK_ORDER = ['video', 'graphics', 'captions', 'audio']

// ---------- register ----------

export const register: Register = on => {
  let hasPixels = false // the terminal speaks the kitty graphics protocol

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cut',
      description: 'Cutroom: HyperFrames cutting-room pane — frame preview, Studio sync, trim/split/move, ask Claude to edit',
      argumentHint: '[project-dir]',
    })
    const [termProgram, kitty, ghostty] = await Promise.all([
      $.env.get('TERM_PROGRAM'),
      $.env.get('KITTY_WINDOW_ID'),
      $.env.get('GHOSTTY_RESOURCES_DIR'),
    ])
    hasPixels = Boolean(kitty || ghostty || /kitty|ghostty/i.test(termProgram ?? ''))
    const started = await next(e)
    const open = await read($, project)
    if (open) {
      // a reload: keep the Studio link and the live selection alive, and redraw the frame
      void (async () => {
        await ensureStudio($, open, false)
        await refresh($, open)
        await startLive($, open)
      })().catch(quiet)
    } else if (e.isInteractive && (await $.fs.exists(`${e.cwd}/hyperframes.json`))) {
      void (async () => {
        await $.ui.open({ id: PANE, title: 'Cutroom', columns: 100, rows: 24 })
        await openProject($, e.cwd, false)
      })().catch(quiet)
    }
    return started
  })

  on('command.run', { command: 'cut' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    let arg = e.args.trim()
    if (arg.startsWith('~')) arg = home + arg.slice(1)
    await $.ui.open({ id: PANE, title: 'Cutroom', focus: true, columns: 100, rows: 24 })
    if (arg) {
      const dir = arg.startsWith('/') ? arg : `${cwd}/${arg}`
      await openProject($, dir, true)
      return { text: `Cutroom: ${dir}` }
    }
    const current = await read($, project)
    if (current) {
      await ensureStudio($, current, true)
      return { text: `Cutroom: ${current}` }
    }
    const last = await $.store.get(`last:${cwd}`)
    if (typeof last === 'string' && (await isProject($, last))) {
      await openProject($, last, true)
      return { text: `Cutroom: ${last}` }
    }
    const found = await findProjects($, cwd)
    await update($, candidates, () => found)
    const only = found[0]
    if (found.length === 1 && only) {
      await openProject($, only, true)
      return { text: `Cutroom: ${only}` }
    }
    return {
      text: found.length
        ? `Cutroom: ${found.length} projects found — pick one in the pane`
        : 'Cutroom: no project under this directory. Run /cut <project-dir>',
    }
  })

  // what the person types in the normal prompt carries the Studio selection and the playhead
  on('prompt.submit', async ($, e, next) => {
    const dir = await read($, project)
    if (!dir || e.origin.kind !== 'composer' || !(await read($, autoContext))) return next(e)
    pendingRefresh = true
    return next({ ...e, context: [...(e.context ?? []), await contextBlock($, dir)] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const dir = await read($, project)
    if (pendingRefresh && dir) {
      pendingRefresh = false
      void refresh($, dir).catch(quiet)
    }
    return done
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    pollTimer?.cancel()
    stopLive()
    await update($, live, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text dimColor>Cutroom needs the terminal or desktop surface.</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const width = Math.max(48, e.props.bodyColumns - 1)
    const [dir, tl, selId, t0, pv, srv, sel, msg, job, rc, cands, ctxOn, lv] = await Promise.all([
      read($, project),
      read($, timeline),
      read($, selected),
      read($, playhead),
      read($, preview),
      read($, studio),
      read($, selection),
      read($, status),
      read($, busy),
      read($, receipts),
      read($, candidates),
      read($, autoContext),
      read($, live),
    ])

    if (!dir) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Cutroom</Text>
          {cands.length > 0 ? (
            <Text dimColor>Pick a project:</Text>
          ) : (
            <Text dimColor>No HyperFrames project under this directory. Run /cut &lt;project-dir&gt;.</Text>
          )}
          {cands.map((c, i) => (
            <Button
              key={`cand:${c}`}
              plain
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              label={c}
              onPress={() => void openProject($, c, true)}
            />
          ))}
          {msg !== '' && <Text dimColor>{msg}</Text>}
        </Box>
      )
    }

    const clips = tl?.clips ?? []
    const clip = clips.find(c => c.id === selId)
    const duration = tl?.duration ?? 0
    const isLive = lv !== null && livePort !== 0
    const isPlaying = isLive && !livePaused
    const t = isPlaying ? liveT : t0

    // the frame: the live player's latest (Svg on the desktop, kitty pixels or half-block
    // cells in a terminal), else the last still
    let frame: JSX.Element
    const inlinePane = e.surface === 'terminal' && e.props.placement === 'inline'
    const liveCols = Math.max(8, Math.min(width - 2, 255, Math.round(((inlinePane ? 10 : 28) * 2 * LIVE_W) / LIVE_H)))
    const liveRows = Math.max(1, Math.round((liveCols * LIVE_H) / LIVE_W / 2))
    if (isLive && e.surface === 'terminal') {
      const want = hasPixels ? 480 : Math.min(512, liveCols * 2)
      if (rgbWant !== want || !liveFrame?.rgb) {
        rgbWant = want
        liveSeq = -1 // the next poll fetches the current frame again, with rgb at this width
      }
    }
    if (isLive && liveFrame && e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const svgW = Math.max(240, Math.min(LIVE_W, Math.round(e.props.bodyColumns * 7.2)))
      const svgH = Math.round((svgW * LIVE_H) / LIVE_W)
      frame = (
        <Svg
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}"><image href="data:image/jpeg;base64,${liveFrame.jpeg}" width="${svgW}" height="${svgH}"/></svg>`}
          alt={`live @ ${fmt(t)}s`}
          width={svgW}
          height={svgH}
        />
      )
    } else if (isLive && e.surface === 'terminal' && liveFrame?.rgb && liveFrame.rgbH > 1) {
      // ponytail: a redraw per frame (≤30/s); $.ui.blit on the keyed Raster/Image if the pane ever stutters
      const bytes = fromB64(liveFrame.rgb)
      if (hasPixels) {
        const { Image } = $.ui.resolve(e)
        frame = <Image key="frame" source={{ rgba: rgbToRgba(bytes), width: liveFrame.rgbW, height: liveFrame.rgbH }} columns={liveCols} rows={liveRows} alt={`live @ ${fmt(t)}s`} />
      } else {
        const { Raster } = $.ui.resolve(e)
        frame = <Raster key="frame" columns={liveCols} rows={liveRows} cells={rasterCells(bytes, liveFrame.rgbW, liveFrame.rgbH, liveCols, liveRows)} />
      }
    } else if (!pv || !pv.rgb) {
      frame = <Text dimColor>{job || 'no frame yet — press ⟳ (r)'}</Text>
    } else if (e.surface === 'terminal') {
      const inline = e.props.placement === 'inline'
      if (hasPixels) {
        const { Image } = $.ui.resolve(e)
        const b64 = await cachedBase64($, pv.png, pv.gen)
        const { width: imgW, height: imgH } = pngSize(b64)
        const maxRows = inline ? 10 : 30
        const cols = Math.max(8, Math.min(255, width - 2, Math.round((maxRows * 2.1 * imgW) / imgH)))
        const rows = Math.max(2, Math.min(255, Math.round((cols * imgH) / imgW / 2.1)))
        frame = <Image key="frame" source={{ png: b64 }} columns={cols} rows={rows} alt={`frame @ ${fmt(pv.at)}s → ${pv.png}`} />
      } else {
        const { Raster } = $.ui.resolve(e)
        const bytes = fromB64(await cachedBase64($, pv.rgb, pv.gen))
        const srcW = pv.rgbW
        const srcH = Math.floor(bytes.length / (srcW * 3))
        if (srcH < 2) {
          frame = <Text dimColor>frame @ {fmt(pv.at)}s → {pv.png}</Text>
        } else {
          const maxRows = inline ? 10 : 28
          const cols = Math.max(8, Math.min(width - 2, 512, Math.round((maxRows * 2 * srcW) / srcH)))
          const rows = Math.max(1, Math.min(256, Math.round((cols * srcH) / srcW / 2)))
          frame = <Raster key="frame" columns={cols} rows={rows} cells={rasterCells(bytes, srcW, srcH, cols, rows)} />
        }
      }
    } else {
      const { Svg } = $.ui.resolve(e)
      const b64 = await cachedBase64($, pv.jpg, pv.gen)
      const png = await cachedBase64($, pv.png, pv.gen)
      const { width: w0, height: h0 } = pngSize(png)
      const svgW = 480
      const svgH = Math.max(1, Math.round((svgW * h0) / w0))
      frame = (
        <Svg
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}"><image href="data:image/jpeg;base64,${b64}" width="${svgW}" height="${svgH}"/></svg>`}
          alt={`frame @ ${fmt(pv.at)}s`}
          width={svgW}
          height={svgH}
        />
      )
    }

    // compact clip list, grouped by track kind
    const kinds = [...TRACK_ORDER.filter(k => clips.some(c => c.trackKind === k)), ...clips.map(c => c.trackKind).filter(k => !TRACK_ORDER.includes(k))].filter(
      (k, i, all) => all.indexOf(k) === i,
    )
    const barW = Math.max(10, width - 36)
    let n = 0
    const rows = kinds.map(kind => (
      <Box flexDirection="column">
        <Text dimColor>{kind}</Text>
        {clips
          .filter(c => c.trackKind === kind)
          .map(c => {
            const i = n++
            const isSel = c.id === selId
            return (
              <Box>
                <Text bold={isSel}>{isSel ? '▸' : ' '}</Text>
                <Button
                  key={`clip:${c.id}`}
                  plain
                  dimColor={!isSel}
                  {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                  label={pad(c.id, 15)}
                  onPress={() => void selectClip($, dir, c)}
                />
                <Text dimColor={!isSel}> {bar(barW, duration, c.absStart, c.absEnd, t)} </Text>
                <Text dimColor>
                  {fmt(c.absStart)}–{fmt(c.absEnd)}
                </Text>
              </Box>
            )
          })}
      </Box>
    ))

    const go = (to: number) => () => void seek($, dir, to)
    const op = (label: string, args: (clip: HfClip, t: number) => string[] | string) => () =>
      void withClip($, async (c, at) => {
        const a = args(c, at)
        if (typeof a === 'string') {
          await say($, a)
          return
        }
        await edit($, dir, label, a)
      })

    const where = sel
      ? `Studio: ${sel.label ?? sel.id ?? sel.selector ?? '?'}${sel.file ? ` · ${sel.file}` : ''}${clip && clip.id !== sel.id ? ` · in clip ${clip.id}` : ''}`
      : clip
        ? `clip ${clip.id} · ${fmt(clip.absStart)}–${fmt(clip.absEnd)}s · ${clip.file}${clip.src ? ` · ${clip.src}` : ''}`
        : 'nothing selected — click something in Studio, or a row below'

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>{base(dir)}</Text>
          <Text dimColor>
            · {fmt(duration)}s · {isLive ? 'live ●' : 'stills'} · Studio {srv ? '●' : '○'}
          </Text>
          <Button key="studio-open" plain hotkey="g" label={srv ? '[open Studio ↗]' : '[start Studio]'} onPress={() => void ensureStudio($, dir, true)} />
          {srv !== null && <Link href={srv.studioUrl} label={srv.studioUrl.replace(/^https?:\/\//, '')} />}
        </Box>
        {frame}
        <Box gap={1}>
          <Button key="play" plain hotkey="p" label={isPlaying ? '❚❚' : '▶'} onPress={() => void togglePlay($)} />
          <Button key="seek-start" plain hotkey="a" label="|◀" onPress={go(clip ? clip.absStart : 0)} />
          <Button key="seek-m1" plain hotkey="j" label="-1s" onPress={go(t - 1)} />
          <Button key="seek-m01" plain hotkey="h" label="-.1" onPress={go(t - 0.1)} />
          <Text bold> {fmt(t)}s </Text>
          <Button key="seek-p01" plain hotkey="l" label="+.1" onPress={go(t + 0.1)} />
          <Button key="seek-p1" plain hotkey="k" label="+1s" onPress={go(t + 1)} />
          <Button key="seek-end" plain hotkey="f" label="▶|" onPress={go(clip ? clip.absEnd - 0.05 : duration)} />
          <Button key="refresh" plain hotkey="r" label="⟳" onPress={() => void capture($, dir, t)} />
          <Input
            key="goto"
            placeholder="t="
            submitLabel="seek"
            onSubmit={v => {
              const num = Number(v)
              if (Number.isFinite(num)) void seek($, dir, num)
            }}
          />
        </Box>
        <Text dimColor>{where}</Text>
        <Box gap={1} flexWrap="wrap">
          <Button
            key="trim-in"
            hotkey="i"
            label="Trim in→┃"
            onPress={op('trim in', (c, at) => (inside(c, at) ? ['trim', c.ref, '--start', fmt(at), '--end', fmt(c.absEnd)] : 'move the playhead inside the clip first'))}
          />
          <Button
            key="trim-out"
            hotkey="o"
            label="┃←Trim out"
            onPress={op('trim out', (c, at) => (inside(c, at) ? ['trim', c.ref, '--end', fmt(at)] : 'move the playhead inside the clip first'))}
          />
          <Button
            key="split"
            hotkey="s"
            label="Split @┃"
            onPress={op('split', (c, at) => (inside(c, at) ? ['split', c.ref, fmt(at)] : 'move the playhead inside the clip first'))}
          />
          <Button key="move" hotkey="m" label="Move→┃" onPress={op('move', (c, at) => ['move', c.ref, fmt(at)])} />
          <Button key="dup" hotkey="d" label="Duplicate" onPress={op('duplicate', c => ['duplicate', c.ref])} />
          <Button key="delete" hotkey="x" label="Delete" onPress={op('delete', c => ['delete', c.ref])} />
          <Button key="undo" hotkey="u" label={`Undo (${rc.length})`} onPress={() => void undoLast($, dir)} />
          <Button key="check" hotkey="c" label="Check" onPress={() => void check($, dir)} />
          <Button key="render" hotkey="v" label="Render draft" onPress={() => void renderDraft($, dir)} />
          <Button key="reload" hotkey="z" label="Reload" onPress={() => void refresh($, dir)} />
          <Button
            key="ctx"
            plain
            hotkey="t"
            dimColor={!ctxOn}
            label={`prompt context: ${ctxOn ? 'on' : 'off'}`}
            onPress={() => void update($, autoContext, v => !v)}
          />
        </Box>
        <Input
          key="ask"
          label="Ask Claude ›"
          placeholder="change what? e.g. 把這段標題放大、進場再慢一點 (or just type in the main prompt)"
          submitLabel="send"
          onSubmit={v => {
            if (v.trim()) void askClaude($, dir, v.trim())
          }}
        />
        <Text dimColor>{job || msg}</Text>
        <Box flexDirection="column">{rows}</Box>
      </Box>
    )
  })
}
