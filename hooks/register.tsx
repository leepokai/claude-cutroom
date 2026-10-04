import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HfClip, HfPreview, HfStudio, HfTimeline } from '../types'

// Cutroom: a HyperFrames cutting-room pane that previews the frame under the playhead,
// lists the timeline, applies the CLI's own clip edits (trim/split/move/
// delete/duplicate/undo), pulls the Studio selection, and hands a
// "change this" request to Claude with the clip + frame context attached.

const PANE = 'cutroom'
const WORK = '.hyperframes/cutroom'

const project = atom({ plugin: 'cutroom', key: 'project' } as const, null as string | null)
const candidates = atom({ plugin: 'cutroom', key: 'candidates' } as const, [] as string[])
const timeline = atom({ plugin: 'cutroom', key: 'timeline' } as const, null as HfTimeline)
const selected = atom({ plugin: 'cutroom', key: 'selected' } as const, null as string | null)
const playhead = atom({ plugin: 'cutroom', key: 'playhead' } as const, 0)
const preview = atom({ plugin: 'cutroom', key: 'preview' } as const, null as HfPreview)
const studio = atom({ plugin: 'cutroom', key: 'studio' } as const, null as HfStudio)
const studioUrl = atom({ plugin: 'cutroom', key: 'studioUrl' } as const, null as string | null)
const status = atom({ plugin: 'cutroom', key: 'status' } as const, '')
const busy = atom({ plugin: 'cutroom', key: 'busy' } as const, '')
const receipts = atom({ plugin: 'cutroom', key: 'receipts' } as const, [] as string[])

type Eng = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const fmt = (n: number) => String(Math.round(n * 100) / 100)
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const tail = (s: string, n = 200) => s.trim().slice(-n)
const say = ($: Eng, text: string) => update($, status, () => text)
const working = ($: Eng, text: string) => update($, busy, () => text)

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
  await update($, project, () => clean)
  await update($, selected, () => null)
  await update($, preview, () => null)
  await update($, studio, () => null)
  await update($, studioUrl, () => null)
  await update($, receipts, () => [])
  await update($, playhead, () => 0)
  await $.store.set(`last:${await $.session.cwd()}`, clean)
  await say($, `opened ${base(clean)}`)
  await refresh($, clean)
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
  void capture($, dir, await read($, playhead))
}

// ---------- frame preview ----------

function pngSize(b64: string) {
  const head = atob(b64.slice(0, 32))
  const u32 = (o: number) =>
    ((head.charCodeAt(o) << 24) >>> 0) + (head.charCodeAt(o + 1) << 16) + (head.charCodeAt(o + 2) << 8) + head.charCodeAt(o + 3)
  return { width: u32(16) || 16, height: u32(20) || 9 }
}

let captureSeq = 0
let captureTimer: { cancel: () => void } | undefined

function scheduleCapture($: Eng, dir: string, at: number) {
  captureTimer?.cancel()
  captureTimer = $.clock.after(500, () => void capture($, dir, at))
}

async function capture($: Eng, dir: string, at: number) {
  const seq = ++captureSeq
  const out = `${dir}/${WORK}`
  await working($, `capturing frame @ ${fmt(at)}s…`)
  const r = await run($, dir, ['snapshot', '--at', fmt(at), '--no-end', '--describe', 'false', '-o', out])
  if (seq !== captureSeq) return // a later seek superseded this one
  const frames = (await $.fs.list(out).catch(() => []))
    .filter(f => /^frame-\d+-at-.*\.png$/.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const frame = frames[0]
  if (!frame) {
    await working($, '')
    return say($, `snapshot failed: ${tail(r.stderr || r.stdout)}`)
  }
  const full = `${out}/${frame.name}`
  const png = `${out}/preview.png`
  const jpg = `${out}/preview.jpg`
  const ff = await $.process.run(
    ['ffmpeg', '-y', '-loglevel', 'error', '-i', full, '-vf', 'scale=960:-2', png, '-vf', 'scale=480:-2', '-q:v', '6', jpg],
    { timeoutMs: 30_000 },
  )
  await $.process.run(['rm', '-f', ...frames.map(f => `${out}/${f.name}`)]).catch(() => undefined)
  if (ff.exitCode !== 0) {
    await working($, '')
    return say($, `ffmpeg: ${tail(ff.stderr)}`)
  }
  const { base64 } = await $.fs.read(png, { as: 'bytes' })
  const { width, height } = pngSize(base64)
  await update($, preview, () => ({ at, png, jpg, width, height, gen: seq }))
  await working($, '')
}

let imageCache: { path: string; gen: number; base64: string } | undefined
async function imageBase64($: Eng, path: string, gen: number) {
  if (imageCache?.path === path && imageCache.gen === gen) return imageCache.base64
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  imageCache = { path, gen, base64 }
  return base64
}

// ---------- edits (the CLI's own timeline mutations) ----------

async function seek($: Eng, dir: string, to: number) {
  const tl = await read($, timeline)
  const max = tl?.duration ?? Number.POSITIVE_INFINITY
  const at = Math.max(0, Math.min(max, Math.round(to * 1000) / 1000))
  await update($, playhead, () => at)
  scheduleCapture($, dir, at)
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
    const why = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '') ?? ''
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
  if (!clip) return say($, 'select a clip first (press its row or its number)')
  await fn(clip, t)
}

const inside = (clip: HfClip, t: number) => t > clip.absStart && t < clip.absEnd

async function undoLast($: Eng, dir: string) {
  const list = await read($, receipts)
  const last = list[list.length - 1]
  if (!last) return say($, 'nothing to undo (only edits made from this pane are undoable here)')
  await working($, 'undo…')
  const r = await run($, dir, ['timeline', 'undo', last, '--json'])
  const j = json(r.stdout)
  await working($, '')
  if (!j?.ok) return say($, `undo failed: ${j?.error?.message ?? tail(r.stderr || r.stdout)}`)
  await update($, receipts, l => l.slice(0, -1))
  await say($, 'undo ✓')
  await refresh($, dir)
}

// ---------- Studio bridge ----------

async function pullStudio($: Eng, dir: string) {
  const r = await run($, dir, ['preview', '--context', '--json', '--context-fields', 'selection,server'])
  const j = json(r.stdout)
  if (!j?.ok) return say($, `Studio: ${j?.error?.message ?? 'not running'} — press Open Studio first`)
  if (j.server?.url) {
    const url = `${String(j.server.url).replace('127.0.0.1', 'localhost')}/#project/${j.server.projectName ?? base(dir)}`
    await update($, studioUrl, () => url)
  }
  const s = j.selection
  if (!s) {
    await update($, studio, () => null)
    return say($, `Studio: ${j.errors?.selection?.message ?? 'no selection'} — click an element in Studio, then press again`)
  }
  const t = s.target ?? {}
  const time = typeof s.currentTime === 'number' ? s.currentTime : typeof s.time === 'number' ? s.time : null
  await update($, studio, () => ({
    hfId: t.hfId ?? null,
    selector: t.selector ?? null,
    file: s.sourceFile ?? s.file ?? t.sourceFile ?? null,
    text: typeof s.textContent === 'string' ? s.textContent.slice(0, 120) : typeof s.text === 'string' ? s.text.slice(0, 120) : null,
    time,
  }))
  if (time !== null) await seek($, dir, time)
  await say($, `Studio selection: ${t.hfId ?? t.selector ?? '?'}`)
}

async function openStudio($: Eng, dir: string) {
  await working($, 'starting Studio…')
  const r = await run($, dir, ['preview', '--background', '--no-open'], 90_000)
  const st = json((await run($, dir, ['preview', '--status', '--json'])).stdout)
  await working($, '')
  const url: string | undefined = st?.result?.studioUrl ?? r.stdout.match(/https?:\/\/\S+#project\/\S+/)?.[0]
  if (!url) return say($, `Studio did not start: ${tail(r.stderr || r.stdout)}`)
  await update($, studioUrl, () => url.replace('127.0.0.1', 'localhost'))
  await say($, 'Studio is running — open the link, click an element there, then press Studio sel')
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

// ---------- point-and-ask ----------

let pendingRefresh = false

async function askClaude($: Eng, dir: string, request: string) {
  const [t, tl, sel, st, pv] = await Promise.all([
    read($, playhead),
    read($, timeline),
    read($, selected),
    read($, studio),
    read($, preview),
  ])
  const clip = tl?.clips.find(c => c.id === sel)
  const lines: Array<string | null> = [
    `[Cutroom] project: ${dir}`,
    `playhead: ${fmt(t)}s${pv ? ` — snapshot of that frame: ${pv.png} (read it to see what is on screen)` : ''}`,
    clip
      ? `selected clip: ${clip.id} on the ${clip.trackKind} track, ${fmt(clip.absStart)}–${fmt(clip.absEnd)}s, declared in ${clip.file}${clip.src ? ` (src ${clip.src})` : ''}`
      : 'selected clip: none',
    st
      ? `Studio selection: ${st.hfId ? `data-hf-id ${st.hfId}` : (st.selector ?? '?')}${st.file ? ` in ${st.file}` : ''}${st.text ? ` text "${st.text}"` : ''}`
      : null,
    '',
    `Edit request: ${request}`,
    '',
    'Make this edit in the HyperFrames project above. Load the hyperframes skill (and hyperframes-core; hyperframes-keyframes for motion, hyperframes-audio for sound) before touching files; change only what the request names; run `hyperframes lint` in the project afterwards; reply in one or two sentences with what changed.',
  ]
  pendingRefresh = true
  await say($, `sent to Claude: ${request.slice(0, 70)}`)
  void $.prompt.submit({ text: lines.filter((l): l is string => l !== null).join('\n') })
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
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cut',
      description: 'Cutroom: HyperFrames cutting-room pane — frame preview, timeline, trim/split/move, Studio selection, ask Claude to edit',
      argumentHint: '[project-dir]',
    })
    const started = await next(e)
    if (e.isInteractive && (await $.fs.exists(`${e.cwd}/hyperframes.json`))) {
      void (async () => {
        await $.ui.open({ id: PANE, title: 'Cutroom', columns: 96, rows: 40 })
        await openProject($, e.cwd)
      })()
    }
    return started
  })

  on('command.run', { command: 'cut' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const home = (await $.env.get('HOME')) ?? ''
    let arg = e.args.trim()
    if (arg.startsWith('~')) arg = home + arg.slice(1)
    await $.ui.open({ id: PANE, title: 'Cutroom', focus: true, columns: 96, rows: 40 })
    if (arg) {
      const dir = arg.startsWith('/') ? arg : `${cwd}/${arg}`
      await openProject($, dir)
      return { text: `Cutroom: ${dir}` }
    }
    const current = await read($, project)
    if (current) return { text: `Cutroom: ${current}` }
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
        ? `Cutroom: ${found.length} projects found — pick one in the pane`
        : 'Cutroom: no project under this directory. Run /cut <project-dir>',
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const dir = await read($, project)
    if (pendingRefresh && dir) {
      pendingRefresh = false
      void refresh($, dir)
    }
    return done
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
    const [dir, tl, sel, t, pv, st, url, msg, job, rc, cands] = await Promise.all([
      read($, project),
      read($, timeline),
      read($, selected),
      read($, playhead),
      read($, preview),
      read($, studio),
      read($, studioUrl),
      read($, status),
      read($, busy),
      read($, receipts),
      read($, candidates),
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
              onPress={() => void openProject($, c)}
            />
          ))}
          {msg !== '' && <Text dimColor>{msg}</Text>}
        </Box>
      )
    }

    const clips = tl?.clips ?? []
    const clip = clips.find(c => c.id === sel)
    const duration = tl?.duration ?? 0

    // preview
    let frame: JSX.Element
    if (!pv) {
      frame = <Text dimColor>{job || 'no frame yet — press ⟳ (r)'}</Text>
    } else if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const cols = Math.min(255, width - 2)
      const rows = Math.min(255, Math.max(4, Math.round((cols * pv.height) / pv.width / 2.1)))
      const b64 = await imageBase64($, pv.png, pv.gen)
      frame = <Image key="frame" source={{ png: b64 }} columns={cols} rows={rows} alt={`frame @ ${fmt(pv.at)}s → ${pv.png}`} />
    } else {
      const { Svg } = $.ui.resolve(e)
      const b64 = await imageBase64($, pv.jpg, pv.gen)
      const w = 480
      const h = Math.max(1, Math.round((w * pv.height) / pv.width))
      frame = (
        <Svg
          source={`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="data:image/jpeg;base64,${b64}" width="${w}" height="${h}"/></svg>`}
          alt={`frame @ ${fmt(pv.at)}s`}
          width={w}
          height={h}
        />
      )
    }

    // timeline rows, grouped by track kind
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
            const isSel = c.id === sel
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

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{base(dir)}</Text>
          <Text dimColor>
            {' '}
            · {fmt(duration)}s · {clips.length} clips · playhead {fmt(t)}s
          </Text>
        </Box>
        {frame}
        <Box gap={1}>
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
        <Box flexDirection="column">{rows}</Box>
        <Box>
          <Text dimColor>
            {clip ? `selected ${clip.id} · ${clip.file}${clip.src ? ` · ${clip.src}` : ''}${clip.children ? ` · ${clip.children} nested` : ''}` : 'no clip selected'}
            {st ? ` · Studio: ${st.hfId ?? st.selector ?? '?'}` : ''}
          </Text>
        </Box>
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
        </Box>
        <Box gap={1} flexWrap="wrap">
          <Button key="studio-open" hotkey="g" label="Open Studio" onPress={() => void openStudio($, dir)} />
          <Button key="studio-sel" hotkey="e" label="Studio sel" onPress={() => void pullStudio($, dir)} />
          <Button key="check" hotkey="c" label="Check" onPress={() => void check($, dir)} />
          <Button key="render" hotkey="v" label="Render draft" onPress={() => void renderDraft($, dir)} />
          <Button key="reload" hotkey="p" label="Reload" onPress={() => void refresh($, dir)} />
          {url !== null && <Link href={url} label="Studio ↗" />}
        </Box>
        <Input
          key="ask"
          label="Ask Claude ›"
          placeholder="change what? e.g. 把這段標題放大、進場再慢一點"
          submitLabel="send"
          onSubmit={v => {
            if (v.trim()) void askClaude($, dir, v.trim())
          }}
        />
        <Text dimColor>{job || msg}</Text>
      </Box>
    )
  })
}
