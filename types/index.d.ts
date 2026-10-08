export type HfClip = {
  id: string
  ref: string
  file: string
  trackKind: string
  absStart: number
  absEnd: number
  src: string | null
  children: number
}
export type HfTimeline = { duration: number; clips: HfClip[] } | null
/** The frame under the playhead: full-size png, a 480px jpg (desktop Svg) and a 192px-wide raw rgb strip (terminal Raster). */
export type HfPreview = { at: number; png: string; jpg: string; rgb: string; rgbW: number; gen: number } | null
declare module 'claude-code' {
  interface PluginState {
    cutroom: {
      project: string | null
      candidates: string[]
      timeline: HfTimeline
      selected: string | null
      playhead: number
      preview: HfPreview
      status: string
      busy: string
      receipts: string[]
      receipts: string[]
      live: { port: number; duration: number } | null
    }
  }
}
