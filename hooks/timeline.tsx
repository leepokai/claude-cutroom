import type { ClientModule } from 'claude-code'

// The Cutroom timeline: one track, cut by time into segments.
//   ruler, or the playhead line: press or drag to scrub
//   segment: click to select it (the playhead goes there); drag its middle to move
//   its clip, drag an edge that is the clip's own edge to trim it; the preview
//   follows while dragging and the release commits
// In a terminal it also draws the track in text cells (mode "text"); on the desktop
// the hooks module draws it as an Svg with real frames and this region lies over
// it, transparent (mode "overlay"), mapping the pointer by fractions of the region
// so it lines up with any font. Every outcome is posted as { op, ... }.

/** a piece of the track, and the clip that names it (whose edges a drag moves) */
export type Segment = { id: string; label: string; start: number; end: number; clipStart: number; clipEnd: number }
/** overlay geometry, as fractions of the region: the inset either side of the track, the ruler band */
export type TimelineGeo = { inset: number; ruler: number }
export type TimelineProps = {
  mode: 'text' | 'overlay'
  duration: number
  t: number
  selected: string | null
  segments: Segment[]
  geo?: TimelineGeo
}
type Kind = 'move' | 'trim-start' | 'trim-end'
type Gesture =
  | { kind: 'none' }
  | { kind: 'scrub' }
  | { kind: 'press'; seg: Segment; grabT: number; edge: Kind } // down on a segment, not yet a drag
  | { kind: Kind; seg: Segment; grabT: number; start: number; end: number }

const ACCENT = '#d97757'
const DIM = '#a6a39a'
const round = (n: number) => Math.round(n * 100) / 100
// the gesture in flight; setState lands a frame late and a drag's events outrun it
// ponytail: module-wide, fine while the pane draws one timeline
let g: Gesture = { kind: 'none' }
let tick = 0

const Timeline: ClientModule<TimelineProps, number> = (p, s) => {
  const { Box, Text } = s.elements
  const d = p.duration > 0 ? p.duration : 1
  const cols = Math.max(1, s.columns)
  const rows = Math.max(1, s.rows)
  const span = p.mode === 'overlay' && p.geo ? 1 - 2 * p.geo.inset : 1
  const edgeT = (0.012 / span) * d // how close to an edge a press grabs it: ~1.2% of the track
  const dragT = d / 150 // movement below this is still a click

  const timeAt = (x: number, fx?: number) => {
    const u = p.mode === 'overlay' && p.geo ? ((fx ?? x + 0.5) / cols - p.geo.inset) / span : x / cols
    return Math.max(0, Math.min(d, u * d))
  }
  const onRuler = (y: number, fy?: number) => (p.mode === 'overlay' && p.geo ? (fy ?? y + 0.5) / rows < p.geo.ruler : y === 0)
  const set = (next: Gesture) => {
    g = next
    s.setState(++tick) // redraw the text track; the overlay draws nothing either way
  }
  const press = (t: number) => {
    const seg = p.segments.find(x => t >= x.start && t < x.end) ?? p.segments[p.segments.length - 1]
    s.post({ op: 'press', t: round(t), id: seg?.id ?? null })
  }

  s.onPointer(ev => {
    const t = timeAt(ev.x, ev.fine?.x)
    if (ev.type === 'down' && ev.button === 'left') {
      // the ruler, or the playhead line itself anywhere down the track, scrubs
      if (onRuler(ev.y, ev.fine?.y) || Math.abs(t - p.t) <= edgeT) {
        set({ kind: 'scrub' })
        s.post({ op: 'seek', t: round(t) })
        return
      }
      const seg = p.segments.find(x => t >= x.start - edgeT && t < x.end + edgeT)
      if (!seg) return set({ kind: 'none' })
      // an edge grabs a trim only where it is the clip's own edge
      const edge: Kind =
        Math.abs(t - seg.end) <= edgeT && Math.abs(seg.end - seg.clipEnd) < 1e-3
          ? 'trim-end'
          : Math.abs(t - seg.start) <= edgeT && Math.abs(seg.start - seg.clipStart) < 1e-3
            ? 'trim-start'
            : 'move'
      set({ kind: 'press', seg, grabT: t, edge })
    } else if (ev.type === 'move' && ev.button === 'left') {
      if (g.kind === 'scrub') return s.post({ op: 'seek', t: round(t) })
      if (g.kind === 'none') return
      if (g.kind === 'press' && Math.abs(t - g.grabT) < dragT) return
      const base = g.kind === 'press' ? { kind: g.edge, seg: g.seg, grabT: g.grabT } : g
      const { seg } = base
      const dt = t - base.grabT
      const len = seg.clipEnd - seg.clipStart
      let start = seg.clipStart
      let end = seg.clipEnd
      if (base.kind === 'move') {
        start = Math.max(0, Math.min(d - len, seg.clipStart + dt))
        end = start + len
      } else if (base.kind === 'trim-start') start = Math.max(0, Math.min(seg.clipEnd - 0.1, seg.clipStart + dt))
      else end = Math.min(d, Math.max(seg.clipStart + 0.1, seg.clipEnd + dt))
      set({ kind: base.kind, seg, grabT: base.grabT, start, end })
      s.post({ op: 'drag', id: seg.id, start: round(start), end: round(end), show: round(base.kind === 'trim-end' ? end - 0.04 : start) })
    } else if (ev.type === 'up') {
      if (g.kind === 'move' || g.kind === 'trim-start' || g.kind === 'trim-end') {
        s.post({ op: 'commit', kind: g.kind, id: g.seg.id, start: round(g.start), end: round(g.end) })
      } else if (g.kind === 'press') press(g.grabT)
      else if (g.kind === 'none' && ev.button === 'left' && !onRuler(ev.y, ev.fine?.y)) press(t) // a click that only focused the region
      set({ kind: 'none' })
    }
  })

  if (p.mode === 'overlay') return <Box width="100%" height="100%" />

  // text mode: a ruler, the segments as coloured runs (│ at the playhead), a ▲ under it
  const toX = (t: number) => Math.max(0, Math.min(cols - 1, Math.floor((t / d) * cols)))
  const playX = toX(p.t)
  const ruler = Array.from({ length: cols }, () => ' ')
  for (let i = 0; i <= 4; i++) {
    const label = `${round((d * i) / 4)}s`
    const x0 = Math.min(cols - label.length, toX((d * i) / 4))
    for (let k = 0; k < label.length; k++) ruler[x0 + k] = label[k] ?? ' '
  }
  const runs = p.segments.map((seg, i) => {
    const a = toX(seg.start)
    const b = i === p.segments.length - 1 ? cols : toX(seg.end)
    const name = ` ${seg.label}`
    let text = ''
    for (let x = a; x < b; x++) text += x === playX ? '│' : x === b - 1 && b < cols ? '▕' : (name[x - a] ?? ' ')
    const isSel = seg.id === p.selected
    return { key: `${seg.id}:${i}`, text, bg: isSel ? ACCENT : i % 2 ? '#30302e' : '#3a3936', fg: isSel ? '#141413' : '#f0eee6' }
  })

  return (
    <Box flexDirection="column">
      <Text color={DIM}>{ruler.join('')}</Text>
      <Text>
        {runs.map(r => (
          <Text key={`seg:${r.key}`} backgroundColor={r.bg} color={r.fg}>
            {r.text}
          </Text>
        ))}
      </Text>
      <Text color={ACCENT}>{' '.repeat(playX)}▲</Text>
    </Box>
  )
}

export default Timeline
