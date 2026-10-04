# claude-mod-cutroom

**Cutroom** is a cutting room for [HyperFrames](https://hyperframes.heygen.com)
videos that lives inside Claude Code. It is a mod (a plugin of function hooks)
that draws a pane in the terminal or the desktop app: the frame under the
playhead, the timeline, the handful of cuts you actually make while reviewing
a generated video, and an **Ask Claude** box for everything else.

It is deliberately not a general NLE. Every edit it makes is one HyperFrames
CLI call (`timeline`, `snapshot`, `preview`, `check`, `render`), so what the
pane does and what Claude would do are the same operations on the same files.
Anything a button cannot say is sent to Claude as a prompt that already carries
the project, the playhead, the frame snapshot, the selected clip and the Studio
selection.

```
my-launch · 45s · 12 clips · playhead 12.5s
┌────────────────────────────────────────────┐
│  (frame snapshot at the playhead)          │   ← Image (kitty/Ghostty), alt elsewhere;
└────────────────────────────────────────────┘     Svg on the desktop app
|◀  -1s  -.1  12.5s  +.1  +1s  ▶|  ⟳   t=____ seek
graphics
▸ el-03-demo     ····████┃·······················  9–16
  el-04-feature  ········█████····················  15.5–22.1
audio
  el-bgm         ███████████████████████████████████  0–45
selected el-03-demo · index.html · compositions/frames/03-demo.html
[ Trim in→┃ ] [ ┃←Trim out ] [ Split @┃ ] [ Move→┃ ] [ Duplicate ] [ Delete ] [ Undo (0) ]
[ Open Studio ] [ Studio sel ] [ Check ] [ Render draft ] [ Reload ]  Studio ↗
Ask Claude › change what? e.g. 把這段標題放大、進場再慢一點            send
```

## Install

```bash
claude plugin marketplace add leepokai/claude-mod-cutroom
claude plugin install cutroom@claude-mod-cutroom
```

For one session without installing: `claude --plugin-dir /path/to/claude-mod-cutroom`.
A symlink to this folder under `~/.claude/skills/cutroom` also auto-loads it in
every session.

Requirements: Node 22, `ffmpeg` on PATH, and either the `hyperframes` Claude
Code plugin (`claude plugin install hyperframes@hyperframes`, whose cached CLI
launcher Cutroom uses) or network access for `npx hyperframes`. The frame
preview draws real pixels in terminals that speak the kitty graphics protocol
(kitty, Ghostty) and in the Claude desktop app; elsewhere it shows the
snapshot's path.

## Use

1. `cd` into a HyperFrames project (or its parent, e.g. a repo with `videos/*`)
   and type `/cut`. With `hyperframes.json` in the cwd the pane opens by itself.
   `/cut <dir>` opens a specific project; with several candidates the pane lists
   them as buttons.
2. **Scrub.** `|◀ -1s -.1 +.1 +1s ▶|` move the playhead (hotkeys `a j h l k f`
   while the pane has focus: ctrl+x tab, or click it). `t=` seeks to a time.
   Each move re-captures the frame (`hyperframes snapshot --at`) after 0.5 s.
3. **Pick a clip.** Press its row, or `1`–`9`. Nested rows are hidden; the row
   shows its file and how many nested elements it hosts.
4. **Cut with the CLI's own edits** (each is one `hyperframes timeline …` call
   and is undoable with `Undo`):
   - `Trim in→┃` (`i`): clip now starts at the playhead, end kept
   - `┃←Trim out` (`o`): clip now ends at the playhead
   - `Split @┃` (`s`): two clips, the second named `<id>-2`
   - `Move→┃` (`m`): clip starts at the playhead, length kept
   - `Duplicate` (`d`): a copy right after it, `<id>-copy`
   - `Delete` (`x`)
   - `Undo` (`u`): restores the previous edit made from this pane
     (receipts live in `<project>/.hyperframes/cutroom/`)
5. **Point at something finer than a clip.** `Open Studio` (`g`) starts
   `hyperframes preview --background` and shows the link; click an element in
   Studio, then `Studio sel` (`e`) pulls its `data-hf-id` / selector and file
   into the pane and moves the playhead to Studio's time.
6. **Ask Claude.** Type the change in `Ask Claude ›` and press Enter. Cutroom
   submits a prompt carrying the project path, the playhead time, the snapshot
   path, the selected clip (id, track, span, file, src) and the Studio selection,
   and tells Claude to load the hyperframes skills, change only what you named,
   and lint. When that turn ends the pane reloads the timeline and the frame.
7. `Check` (`c`) runs `hyperframes check --json`; `Render draft` (`v`) writes
   `renders/draft.mp4`; `Reload` (`p`) re-reads the timeline.

## Try it

1. Make a project if you have none: `npx hyperframes init demo`.
2. In Claude Code: `/cut demo`. Press a clip row, nudge the playhead with
   `-1s / +1s` and watch the frame re-capture. Press `Split @┃`, then `Undo`.
3. Type a change in `Ask Claude ›` (for example "make the title 20% larger")
   and press Enter.

## Layout

A Claude Code mod is three files plus a type contract (see the
`plugin-authoring` skill inside Claude Code). This repo is one such mod and
doubles as its own plugin marketplace.

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   lets `claude plugin marketplace add` point here
hooks/hooks.json                  names the hooks module
hooks/register.tsx                the whole mod: CLI runner, state atoms, edit
                                  verbs, Studio bridge, prompt composer, Pane render
types/index.d.ts                  the $.state contract the pane draws from
tests/editor.test.tsx             claude plugin test .
```

- `claude plugin validate .` lists every hook and `$` call the engine will see.
- `claude plugin test .` runs the test against the real engine, with the world
  beneath the plugin (fs, process, store, env, clock) answered by the test:
  clips list, nested rows hidden, select, seek, and `Split` reaching the CLI
  with the exact argv; a split outside the clip is refused before anything runs.
- Once loaded from a folder you own, the engine lays its API declarations under
  `.claude-plugin/types/`, and `tsc -p .` type-checks the mod.

## License

MIT, see [LICENSE](./LICENSE).
