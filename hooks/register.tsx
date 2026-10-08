import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HfClip, HfPreview, HfTimeline } from '../types'
import type { Segment, TimelineGeo, TimelineProps } from './timeline'

// Cutroom: a CapCut-style cutting room for HyperFrames projects, inside Claude Code.
//
// Self-contained: no HyperFrames Studio. A live player (player/cutroom-player.mjs)
// plays the composition in headless Chrome and streams its frames into the pane
// (an Svg on the desktop app, kitty pixels or half-block cells in a terminal).
// Cuts are the HyperFrames CLI's own `timeline` verbs; everything else goes to
// Claude, with the selected clip, the playhead and a snapshot attached.

const PANE = 'cutroom'
const WORK = '.hyperframes/cutroom'
const RGB_W = 192 // width of the raw strip the terminal thumbnail is built from
const LIVE_W = 1280 // the live player's viewport
const LIVE_H = 720

const project = atom({ plugin: 'cutroom', key: 'project' } as const, null as string | null)
const candidates = atom({ plugin: 'cutroom', key: 'candidates' } as const, [] as string[])
const timeline = atom({ plugin: 'cutroom', key: 'timeline' } as const, null as HfTimeline)
const selected = atom({ plugin: 'cutroom', key: 'selected' } as const, null as string | null)
const playhead = atom({ plugin: 'cutroom', key: 'playhead' } as const, 0)
const preview = atom({ plugin: 'cutroom', key: 'preview' } as const, null as HfPreview)
const status = atom({ plugin: 'cutroom', key: 'status' } as const, '')
const busy = atom({ plugin: 'cutroom', key: 'busy' } as const, '')
const receipts = atom({ plugin: 'cutroom', key: 'receipts' } as const, [] as string[])
const live = atom({ plugin: 'cutroom', key: 'live' } as const, null as { port: number; duration: number } | null)

type Eng = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const fmt = (n: number) => String(Math.round(n * 100) / 100)
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const tail = (s: string, n = 200) => s.trim().slice(-n)
let sayTimer: { cancel: () => void } | undefined
/** a status line that clears itself after a few seconds */
const say = ($: Eng, text: string) => {
  sayTimer?.cancel()
  if (text) sayTimer = $.clock.after(6000, () => void update($, status, () => '').catch(() => undefined))
  return update($, status, () => text)
}
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

async function openProject($: Eng, dir: string) {
  const clean = dir.replace(/\/+$/, '')
  if (!(await isProject($, clean))) return say($, `not a HyperFrames project: ${clean}`)
  stopLive()
  await update($, live, () => null)
  await update($, project, () => clean)
  await update($, selected, () => null)
  await update($, preview, () => null)
  await update($, playhead, () => 0)
  await update($, receipts, () => [])
  await $.store.set(`last:${await $.session.cwd()}`, clean)
  await say($, '')
  await loadTimeline($, clean)
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
  if (await liveCmd($, { op: 'reload' })) void loadStrip($).catch(quiet)
  else void capture($, dir, await read($, playhead)).catch(quiet)
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

/** Grabs the frame at `at` with `hyperframes snapshot` (~4 s); the poster before the live player is up. */
async function grabFrame($: Eng, dir: string, at: number, out: string): Promise<string | null> {
  const full = `${out}/frame.png`
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
  await working($, 'Starting preview…')
  let head = ''
  let lastErr = ''
  try {
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        lastErr = text.trim().slice(-200) || lastErr
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
        await say($, `Preview didn't start: ${first?.error ?? head.slice(0, 200)} (showing stills)`)
        continue
      }
      livePort = Number(first.port)
      await update($, live, () => ({ port: livePort, duration: Number(first.duration ?? 0) }))
      await liveCmd($, { op: 'seek', t: await read($, playhead) })
      liveTimer = $.clock.every(30, () => void pollLive($).catch(quiet)) // ~33 fps; a poll in flight skips the next
      void loadStrip($).catch(quiet)
    }
  } catch (err) {
    if (liveStream === stream) await say($, `Preview stopped: ${String(err).slice(0, 200)}`)
  }
  if (liveStream === stream) {
    if (lastErr) await say($, `Preview stopped: ${lastErr}`)
    stopLive()
    await update($, live, () => null)
    await working($, '')
  }
}

async function liveCall($: Eng, cmd: { op: string; t?: number; path?: string; n?: number; w?: number }): Promise<Json> {
  if (!livePort) return null
  const q = new URLSearchParams(Object.entries(cmd).map(([k, v]) => [k, String(v)]))
  const r = await $.http.fetch(`http://127.0.0.1:${livePort}/cmd?${q}`).catch(() => null)
  return r?.ok ? (json(r.text) ?? {}) : null
}
const liveCmd = async ($: Eng, cmd: { op: string; t?: number; path?: string }) => (await liveCall($, cmd)) !== null

// the desktop redraws a pane ten times a second at most: every redraw carries the frames that arrived
// since the last one, and the Svg flips through them itself (SMIL), so playback runs at the player's rate
const FLIP_BUDGET = 120_000 // base64 chars of frames per Svg; the Svg holds 131072
const FLIP_SPAN = 0.1 // seconds one redraw's frames are spread over
let flip: string[] = []

/** the frames to show this redraw, newest last, as many as fit the budget (always the newest) */
function takeFlip(): string[] {
  const out: string[] = []
  let size = 0
  for (let i = flip.length - 1; i >= 0; i--) {
    const f = flip[i] ?? ''
    if (out.length && size + f.length > FLIP_BUDGET) break
    out.unshift(f)
    size += f.length
  }
  flip = []
  return out
}

/** one Svg that shows `frames` in turn over FLIP_SPAN and holds the last */
function flipbookSvg(w: number, h: number, frames: string[]) {
  const dt = FLIP_SPAN / frames.length
  const img = (f: string, i: number) => {
    // each frame shows from its slot on; the next one, drawn on top, covers it
    return `<image href="data:image/jpeg;base64,${f}" width="${w}" height="${h}"${i === 0 ? '' : ' visibility="hidden"'}>${i === 0 ? '' : `<set attributeName="visibility" to="visible" begin="${(i * dt).toFixed(3)}s" fill="freeze"/>`}</image>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${frames.map(img).join('')}</svg>`
}

// thumbnails for the timeline: STRIP_N frames spread over the whole composition
const STRIP_N = 10
let strip: string[] = []
async function loadStrip($: Eng) {
  const j = await liveCall($, { op: 'strip', n: STRIP_N, w: 320 })
  const frames = j?.state?.frames
  if (Array.isArray(frames) && frames.every(f => typeof f === 'string')) {
    strip = frames
    $.ui.invalidate('ui.render')
  }
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
      flip.push(j.jpeg)
      if (flip.length > 8) flip.shift()
      $.ui.invalidate('ui.render')
    } else if (moved || wasPaused !== livePaused) $.ui.invalidate('ui.render')
    if (livePaused && (moved || !wasPaused)) await update($, playhead, () => t)
  } finally {
    liveInflight = false
  }
}

async function togglePlay($: Eng) {
  const d = (await read($, timeline))?.duration ?? 0
  if (livePaused && d > 0 && liveT >= d - 0.05) await liveCmd($, { op: 'seek', t: 0 }) // at the end: play from the top
  if (!(await liveCmd($, { op: 'toggle' }))) await say($, 'Preview is not running. Run /cut again.')
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
  await say($, `${label} done`)
  await refresh($, dir)
}

async function undoLast($: Eng, dir: string) {
  const list = await read($, receipts)
  const last = list[list.length - 1]
  if (!last) return say($, 'Nothing to undo')
  await working($, 'undo…')
  const r = await run($, dir, ['timeline', 'undo', last, '--json'])
  const j = json(r.stdout)
  await working($, '')
  if (!j?.ok) return say($, `undo failed: ${j?.error?.message ?? tail(r.stderr || r.stdout)}`)
  await update($, receipts, l => l.slice(0, -1))
  await say($, 'undo done')
  await refresh($, dir)
}

// ---------- upload ----------

/** the system's file dialog (macOS; zenity elsewhere) → the file copied into <project>/assets → Claude places it */
async function upload($: Eng, dir: string) {
  await working($, 'Choose a file…')
  const mac = await $.process
    .run(['osascript', '-e', 'POSIX path of (choose file with prompt "Add media to the video")'], { timeoutMs: 600_000 })
    .catch(() => null)
  const pick = mac ?? (await $.process.run(['zenity', '--file-selection', '--title=Add media to the video'], { timeoutMs: 600_000 }).catch(() => null))
  await working($, '')
  const src = pick?.exitCode === 0 ? pick.stdout.trim() : ''
  if (!src) return say($, 'Upload cancelled')
  const name = (src.split('/').pop() ?? 'media').replace(/[^\w.\-]+/g, '-')
  await $.process.run(['mkdir', '-p', `${dir}/assets`])
  const cp = await $.process.run(['cp', src, `${dir}/assets/${name}`])
  if (cp.exitCode !== 0) return say($, `Upload failed: ${tail(cp.stderr)}`)
  pendingRefresh = true
  const at = livePort && !livePaused ? liveT : await read($, playhead)
  await say($, `Added assets/${name}`)
  void $.prompt.submit({ text: `Add the uploaded file assets/${name} to the video, starting at the playhead (${fmt(at)}s).\n\n${await contextBlock($, dir)}` })
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
  await say($, r.exitCode === 0 ? `check passed${counts}` : `check failed (exit ${r.exitCode})${counts}. Ask Claude to fix the findings.`)
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
  const [t, tl, selId, pv] = await Promise.all([read($, playhead), read($, timeline), read($, selected), read($, preview)])
  const clip = tl?.clips.find(c => c.id === selId)
  const lines: string[] = [`[Cutroom] The person is editing the HyperFrames project at ${dir} in the Cutroom pane.`]
  const seg = clip && tl ? segmentsOf(tl.clips, tl.duration).find(g => g.id === clip.id) : undefined
  if (seg) lines.push(`Selected segment ("this" / 這個 / 這段 means it): ${fmt(seg.start)}–${fmt(seg.end)}s of the video, shown as "${seg.label}".`)
  lines.push(
    clip
      ? `Its clip: ${clip.id} on the ${clip.trackKind} track, ${fmt(clip.absStart)}–${fmt(clip.absEnd)}s, declared in ${clip.file}${clip.src ? ` (src ${clip.src})` : ''}.`
      : 'Nothing is selected.',
  )
  const still = `${dir}/${WORK}/live.jpg`
  const shot = (await liveCmd($, { op: 'save', path: still })) ? still : pv?.png
  lines.push(`Playhead: ${fmt(livePort && !livePaused ? liveT : t)}s.${shot ? ` A snapshot of that frame is at ${shot} (Read it to see the picture).` : ''}`)
  if (tl) {
    lines.push(
      `Timeline (${fmt(tl.duration)}s): ${tl.clips.map(c => `${c.id} [${c.trackKind}] ${fmt(c.absStart)}–${fmt(c.absEnd)}${c.src ? ` ${c.src}` : ''}`).join('; ')}`,
    )
  }
  lines.push(
    'Before editing composition files load the hyperframes skill (and hyperframes-core; hyperframes-keyframes for motion, hyperframes-audio for sound). Use `hyperframes timeline <verb>` for cuts and `hyperframes snapshot --at <t>` to look at any other frame. Change only what the person named, run `hyperframes lint` afterwards, and keep the reply to one or two sentences. The Cutroom pane reloads by itself.',
  )
  return lines.join('\n')
}

// ---------- drawing helpers ----------

/** 3.25 → "00:03.2" */
const clock = (n: number) => {
  const v = Math.max(0, n)
  const m = Math.floor(v / 60)
  return `${String(m).padStart(2, '0')}:${(v - m * 60).toFixed(1).padStart(4, '0')}`
}
const pct = (n: number, d: number) => `${Math.round(Math.max(0, Math.min(100, d > 0 ? (n / d) * 100 : 0)))}%` // the engine takes whole percentages

// a CapCut-like dark editor; one colour per track kind
// Anthropic's palette: warm slate neutrals, ivory text, Claude's clay as the one accent
const UI = { bg: '#1f1e1d', panel: '#262624', lane: '#30302e', text: '#f0eee6', dim: '#a6a39a', accent: '#d97757', head: '#faf9f5', black: '#141413' }
const TRACK_ORDER = ['video', 'graphics', 'captions', 'audio']

// ---------- the timeline: one track, cut by time ----------

const nice = (id: string) => {
  const s = id.replace(/[-_](layer|comp|composition|clip|scene)$/i, '').replace(/[-_]+/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** every clip edge is a cut; each piece is named for the shortest clip covering it (the most specific content there) */
function segmentsOf(clips: HfClip[], duration: number): Segment[] {
  const d = duration
  const cuts = [...new Set([0, d, ...clips.flatMap(c => [c.absStart, c.absEnd])].filter(x => x >= 0 && x <= d))].sort((a, b) => a - b)
  const out: Segment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] ?? 0
    const b = cuts[i + 1] ?? d
    if (b - a < 0.05) continue
    const cover = clips
      .filter(c => c.absStart <= a + 1e-6 && c.absEnd >= b - 1e-6)
      .sort((x, y) => x.absEnd - x.absStart - (y.absEnd - y.absStart) || TRACK_ORDER.indexOf(x.trackKind) - TRACK_ORDER.indexOf(y.trackKind))[0]
    const id = cover?.id ?? `gap-${i}`
    const last = out[out.length - 1]
    if (last && last.id === id) last.end = b
    else out.push({ id, label: cover ? nice(cover.id) : 'Empty', start: a, end: b })
  }
  return out
}

const TL = { inset: 2, ruler: 26, track: 84, radius: 10, gap: 3 }
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** the track as one Svg document (real frames inside each segment), plus the geometry the pointer overlay maps against */
// the track's Svg is the heaviest string in a redraw: rebuild it only when something drawn in it changes
// (the playhead on a 0.1 s grid), not on every live frame
let svgCache: { key: string; value: ReturnType<typeof buildTimelineSvg> } | null = null
function timelineSvg(width: number, duration: number, t: number, selected: string | null, segs: Segment[], frames: string[]) {
  const key = `${width}|${duration}|${Math.round(t * 10)}|${selected}|${frames.length}|${frames[0]?.length ?? 0}|${segs.map(g => `${g.id}:${g.start}:${g.end}`).join(',')}`
  if (svgCache?.key !== key || svgCache.value.frames !== frames) svgCache = { key, value: buildTimelineSvg(width, duration, t, selected, segs, frames) }
  return svgCache.value
}
function buildTimelineSvg(width: number, duration: number, t: number, selected: string | null, segs: Segment[], frames: string[]) {
  const d = duration > 0 ? duration : 1
  const w = width - 2 * TL.inset
  const height = TL.ruler + TL.track + 4
  const x = (s: number) => TL.inset + (Math.max(0, Math.min(d, s)) / d) * w
  const y = TL.ruler
  const slot = w / Math.max(1, frames.length)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif">`,
    '<defs>',
    ...frames.map((f, i) => `<image id="f${i}" width="${slot + 1}" height="${TL.track}" preserveAspectRatio="xMidYMid slice" href="data:image/jpeg;base64,${f}" xlink:href="data:image/jpeg;base64,${f}"/>`),
    `<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="${UI.black}" stop-opacity="0"/><stop offset="1" stop-color="${UI.black}" stop-opacity=".78"/></linearGradient>`,
    '</defs>',
  ]
  // ruler: a tick a second (labelled every quarter)
  const step = d <= 12 ? 1 : d <= 60 ? 5 : 15
  for (let s = 0; s <= d + 1e-6; s += step) out.push(`<line x1="${x(s)}" y1="${y - 7}" x2="${x(s)}" y2="${y - 3}" stroke="#5e5d59"/>`)
  for (let i = 0; i <= 4; i++) {
    const s = (d * i) / 4
    out.push(`<text x="${x(s)}" y="${y - 11}" fill="${UI.dim}" font-size="11" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${fmt(s)}s</text>`)
  }
  out.push(`<rect x="${TL.inset}" y="${y}" width="${w}" height="${TL.track}" rx="${TL.radius}" fill="${UI.lane}"/>`)
  segs.forEach((g, gi) => {
    const x0 = x(g.start) + (gi === 0 ? 0 : TL.gap / 2)
    const x1 = x(g.end) - (gi === segs.length - 1 ? 0 : TL.gap / 2)
    const sw = Math.max(4, x1 - x0)
    const id = `s${gi}`
    out.push(`<clipPath id="${id}"><rect x="${x0}" y="${y}" width="${sw}" height="${TL.track}" rx="${TL.radius}"/></clipPath><g clip-path="url(#${id})">`)
    out.push(`<rect x="${x0}" y="${y}" width="${sw}" height="${TL.track}" fill="${UI.panel}"/>`)
    frames.forEach((_, i) => {
      const fs = ((i + 0.5) * d) / frames.length
      if (x(fs) + slot / 2 < x0 || x(fs) - slot / 2 > x1) return
      out.push(`<use href="#f${i}" xlink:href="#f${i}" x="${x(fs) - slot / 2}" y="${y}"/>`)
    })
    out.push(`<rect x="${x0}" y="${y}" width="${sw}" height="${TL.track}" fill="url(#shade)"/>`)
    if (sw > 54) {
      out.push(`<text x="${x0 + 10}" y="${y + TL.track - 12}" fill="${UI.head}" font-size="12.5" font-weight="600">${esc(g.label)}</text>`)
      if (sw > 120) out.push(`<text x="${x1 - 10}" y="${y + TL.track - 12}" fill="${UI.head}" fill-opacity=".7" font-size="11" text-anchor="end">${fmt(g.end - g.start)}s</text>`)
    }
    out.push('</g>')
    const isSel = g.id === selected
    out.push(`<rect x="${x0 + 1}" y="${y + 1}" width="${sw - 2}" height="${TL.track - 2}" rx="${TL.radius - 1}" fill="none" stroke="${isSel ? UI.accent : 'rgba(240,238,230,.10)'}" stroke-width="${isSel ? 2.5 : 1}"/>`)
  })
  const px = x(t)
  out.push(`<line x1="${px}" y1="${y - 6}" x2="${px}" y2="${y + TL.track + 3}" stroke="${UI.head}" stroke-width="2" stroke-linecap="round"/>`)
  out.push(`<circle cx="${px}" cy="${y - 7}" r="4.5" fill="${UI.head}"/>`)
  out.push('</svg>')
  const geo: TimelineGeo = { inset: TL.inset / width, ruler: TL.ruler / height }
  return { source: out.join(''), height, geo, frames }
}

// ---------- register ----------

export const register: Register = on => {
  let hasPixels = false // the terminal speaks the kitty graphics protocol

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cut',
      description: 'Cutroom: live preview and a draggable timeline for a HyperFrames project',
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
      // a reload: redraw the timeline and restart the player
      void (async () => {
        await refresh($, open)
        await startLive($, open)
      })().catch(quiet)
    } else if (e.isInteractive && (await $.fs.exists(`${e.cwd}/hyperframes.json`))) {
      void (async () => {
        await $.ui.open({ id: PANE, title: 'Cutroom', columns: 100, rows: 24 })
        await openProject($, e.cwd)
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
      await openProject($, dir)
      return { text: `Cutroom: ${dir}` }
    }
    const current = await read($, project)
    if (current) {
      if (!livePort) void startLive($, current).catch(quiet)
      return { text: `Cutroom: ${current}` }
    }
    const last = await $.store.get(`last:${cwd}`)
    if (typeof last === 'string' && (await isProject($, last))) {
      await openProject($, last)
      return { text: `Cutroom: ${last}` }
    }
    const found = await findProjects($, cwd)
    await update($, candidates, () => found)
    const only = found[0]
    if (found.length === 1 && only) {
      await openProject($, only)
      return { text: `Cutroom: ${only}` }
    }
    return {
      text: found.length
        ? `Cutroom: ${found.length} projects found, pick one in the pane`
        : 'Cutroom: no project under this directory. Run /cut <project-dir>',
    }
  })

  // what the person types in the normal prompt carries the selected clip and the playhead
  on('prompt.submit', async ($, e, next) => {
    const dir = await read($, project)
    if (!dir || e.origin.kind !== 'composer') return next(e)
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
    stopLive()
    await update($, live, () => null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text dimColor>Cutroom needs the terminal or the desktop app.</Text>
        </Box>
      )
    }
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const width = Math.max(48, e.props.bodyColumns - 1)
    const [dir, tl, selId, t0, pv, msg, job, cands, lv, rc] = await Promise.all([
      read($, project),
      read($, timeline),
      read($, selected),
      read($, playhead),
      read($, preview),
      read($, status),
      read($, busy),
      read($, candidates),
      read($, live),
      read($, receipts),
    ])

    if (!dir) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Cutroom</Text>
          {cands.length > 0 ? (
            <Text dimColor>Pick a project:</Text>
          ) : (
            <Text dimColor>No HyperFrames project here. Run /cut &lt;project-dir&gt;.</Text>
          )}
          {cands.map((c, i) => (
            <Button
              key={`cand:${c}`}
              plain
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              label={c}
              onPress={() => void openProject($, c)}
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

    const deskW = Math.max(240, Math.min(LIVE_W, Math.round(e.props.bodyColumns * 7.2) - 24))
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
      const svgW = deskW
      const svgH = Math.round((svgW * LIVE_H) / LIVE_W)
      const frames = isPlaying ? takeFlip() : []
      frame = (
        <Svg
          source={frames.length > 1 ? flipbookSvg(svgW, svgH, frames) : `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}"><image href="data:image/jpeg;base64,${frames[0] ?? liveFrame.jpeg}" width="${svgW}" height="${svgH}"/></svg>`}
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
      frame = <Text color={UI.dim}>{job || 'Loading preview…'}</Text>
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
      const svgW = deskW
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

    const go = (to: number) => () => void seek($, dir, to)
    // key badges help in a terminal; on the desktop they are clutter
    const hk = (key: string) => (e.surface === 'terminal' ? { hotkey: key } : {})

    const segs = segmentsOf(clips, duration)
    let timelineEl: JSX.Element
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      let svg = timelineSvg(deskW, duration, t, selId, segs, strip)
      if (svg.source.length > 130_000) svg = timelineSvg(deskW, duration, t, selId, segs, []) // too big with frames
      const props: TimelineProps = { mode: 'overlay', duration, t, selected: selId, segments: segs, geo: svg.geo }
      timelineEl = (
        <Box position="relative" alignSelf="flex-start">
          <Svg source={svg.source} alt={`timeline: ${segs.map(g => g.label).join(', ')}`} width={deskW} height={svg.height} />
          <Box position="absolute" top={0} left={0} width="100%" height="100%">
            <Client key="timeline" module="./timeline.tsx" props={props} width="100%" height="100%" />
          </Box>
        </Box>
      )
    } else {
      const props: TimelineProps = { mode: 'text', duration, t, selected: selId, segments: segs }
      timelineEl = <Client key="timeline" module="./timeline.tsx" props={props} width="100%" height={3} />
    }
    const seg = segs.find(g => g.id === selId)
    const target = seg ?? segs.find(g => t >= g.start && t < g.end)
    const tclip = clips.find(c => c.id === target?.id)
    const cut = (label: string, args: (c: HfClip) => string[] | string) => () => {
      if (!tclip) return void say($, 'Click a segment first')
      const a = args(tclip)
      void (typeof a === 'string' ? say($, a) : edit($, dir, label, a))
    }
    const inside = (c: HfClip) => t > c.absStart + 0.02 && t < c.absEnd - 0.02
    const NOT_INSIDE = 'Move the playhead inside the segment first'

    return (
      <Box flexDirection="column" backgroundColor={UI.bg} paddingX={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box gap={1}>
            <Text bold color={UI.text}>
              {base(dir)}
            </Text>
            <Text color={UI.dim}>{fmt(duration)}s</Text>
          </Box>
          <Box gap={1}>
            <Button key="upload" {...hk('n')} variant="secondary" label="Upload" onPress={() => void upload($, dir)} />
            <Button key="render" {...hk('v')} variant="primary" label="Export" onPress={() => void renderDraft($, dir)} />
          </Box>
        </Box>

        <Box justifyContent="center" backgroundColor={UI.black}>
          <Box position="relative">
            {frame}
            <Box position="absolute" top={0} left={0} width="100%" height="100%">
              <Client key="tap" module="./tap.tsx" props={null} width="100%" height="100%" />
            </Box>
          </Box>
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text color={UI.text}>
            {clock(t)} <Text color={UI.dim}>/ {clock(duration)}</Text>
          </Text>
          <Box gap={2} alignItems="center">
            <Button key="seek-start" plain {...hk('a')} label="⏮" onPress={go(clip ? clip.absStart : 0)} />
            <Button key="seek-m1" plain {...hk('j')} label="−1s" onPress={go(t - 1)} />
            <Button key="play" plain {...hk('p')} label={isPlaying ? '❚❚' : '▶'} onPress={() => void togglePlay($)} />
            <Button key="seek-p1" plain {...hk('k')} label="+1s" onPress={go(t + 1)} />
            <Button key="seek-end" plain {...hk('f')} label="⏭" onPress={go(clip ? clip.absEnd - 0.05 : duration)} />
          </Box>
          <Text color={isLive ? UI.accent : UI.dim}>{isLive ? '● Live' : '○ Still'}</Text>
        </Box>

        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="split" {...hk('s')} variant="secondary" label="✂ Split" onPress={cut('split', c => (inside(c) ? ['split', c.ref, fmt(t)] : NOT_INSIDE))} />
          <Button key="trim-in" {...hk('i')} variant="secondary" label="⇤ Trim start" onPress={cut('trim start', c => (inside(c) ? ['trim', c.ref, '--start', fmt(t), '--end', fmt(c.absEnd)] : NOT_INSIDE))} />
          <Button key="trim-out" {...hk('o')} variant="secondary" label="Trim end ⇥" onPress={cut('trim end', c => (inside(c) ? ['trim', c.ref, '--end', fmt(t)] : NOT_INSIDE))} />
          <Button key="delete" {...hk('x')} variant="secondary" label="Delete" onPress={cut('delete', c => ['delete', c.ref])} />
          <Box flexGrow={1} />
          <Button key="undo" {...hk('u')} variant="secondary" label={`↶ Undo${rc.length ? ` (${rc.length})` : ''}`} onPress={() => void undoLast($, dir)} />
        </Box>
        {timelineEl}

        <Text color={UI.dim}>
          {job ||
            [seg ? `${seg.label}, ${fmt(seg.start)}-${fmt(seg.end)}s selected. Tell Claude what to change.` : 'Click a segment to select it, drag to scrub. Tell Claude what to change.', msg]
              .filter(Boolean)
              .join('  ·  ')}
        </Text>
      </Box>
    )
  })

  // the timeline Client posts what the pointer did
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const dir = await read($, project)
    const m = e.data as { op?: string; t?: number; id?: string; start?: number } | null
    if (!dir || !m) return {}
    const tl = await read($, timeline)
    const c = tl?.clips.find(x => x.id === m.id)
    if (m.op === 'toggle') {
      await togglePlay($)
      return {}
    }
    if (typeof m.t === 'number') await seek($, dir, m.t)
    if (m.op === 'press') await update($, selected, () => (c ? c.id : null))
    return {}
  })
}
