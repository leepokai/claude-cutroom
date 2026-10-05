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
/** The running Studio server for the open project. */
export type HfStudio = { serverUrl: string; studioUrl: string; projectName: string } | null
/** What the person last selected in Studio. */
export type HfSelection = {
  id: string | null
  hfId: string | null
  selector: string | null
  file: string | null
  label: string | null
  text: string | null
  time: number | null
  updatedAt: string | null
} | null

declare module 'claude-code' {
  interface PluginState {
    cutroom: {
      project: string | null
      candidates: string[]
      timeline: HfTimeline
      selected: string | null
      playhead: number
      preview: HfPreview
      studio: HfStudio
      selection: HfSelection
      status: string
      busy: string
      receipts: string[]
      autoContext: boolean
      live: { port: number; duration: number } | null
    }
  }
}
