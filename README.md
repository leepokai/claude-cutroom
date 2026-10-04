# claude-mod-cutroom

**Cutroom** is a cutting room for [HyperFrames](https://hyperframes.heygen.com)
videos that lives inside Claude Code. One command opens HyperFrames **Studio**
in your browser (the real preview and timeline), puts a live frame thumbnail
and the cut buttons in a Claude Code pane, and makes Claude aware of what you
have selected in Studio, so "make this bigger" needs no further pointing.

It is deliberately not another NLE. Studio is the canvas. Every cut the pane
makes is one HyperFrames CLI call (`timeline`, `snapshot`, `check`, `render`),
and everything a button cannot say goes to Claude as a prompt that already
carries the project, the Studio selection, the playhead, the frame snapshot
and the timeline.

```
my-launch · 45s · Studio ●  [open Studio ↗]  localhost:3061/#project/my-launch
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   ← the frame under the
█████████████████▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀████     playhead, as half-block
████████████████  Message your coding agents  ████████████████     cells in any terminal,
████████████████  like teammates.             ████████████████     real pixels on kitty /
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀     Ghostty and the desktop app
▶  |◀  -1s  -.1  12.5s  +.1  +1s  ▶|  ⟳   t=____ seek
Studio: 03 Demo · compositions/frames/03-demo.html
[ Trim in→┃ ] [ ┃←Trim out ] [ Split @┃ ] [ Move→┃ ] [ Duplicate ] [ Delete ] [ Undo (0) ]
[ Check ] [ Render draft ] [ Reload ]  prompt context: on
Ask Claude › change what? (or just type in the main prompt)
graphics
▸ el-03-demo     ····████┃·······················  9–16
  el-04-feature  ········█████····················  15.5–22.1
```

## Install

```bash
claude plugin marketplace add leepokai/claude-mod-cutroom
claude plugin install cutroom@claude-mod-cutroom
```

For one session without installing: `claude --plugin-dir /path/to/claude-mod-cutroom`.
A symlink to this folder under `~/.claude/skills/cutroom` also auto-loads it in
every session.

Requirements: Node 22, `ffmpeg` and `curl` on PATH, and either the `hyperframes` Claude
Code plugin (`claude plugin install hyperframes@hyperframes`, whose cached CLI
launcher Cutroom uses) or network access for `npx hyperframes`. The frame
preview draws real pixels in terminals that speak the kitty graphics protocol
(kitty, Ghostty) and in the Claude desktop app, and half-block cells in every
other terminal.

## Use

1. `cd` into a HyperFrames project (or its parent, e.g. a repo with `videos/*`)
   and type `/cut`. Studio starts in the background and opens in your browser;
   the pane opens beside the transcript (docked in the fullscreen layout from
   110 columns, else above the prompt). With `hyperframes.json` in the cwd the
   pane opens by itself at session start (without launching a browser).
   `/cut <dir>` opens a specific project; with several candidates the pane lists
   them as buttons.
2. **Look.** The pane shows the frame under the playhead: Studio's thumbnail
   API renders it in about half a second. `▶` (`p`) plays it as a slideshow,
   one frame every 0.5 s of timeline, as fast as frames arrive. `|◀ -1s -.1 +.1
   +1s ▶|` scrub (hotkeys `a j h l k f` while the pane has focus: ctrl+x tab,
   or click it); `t=` seeks to a time; `⟳` (`r`) re-captures.
3. **Point.** Click anything in Studio, on the canvas or in its timeline. The
   pane polls Studio's selection every 1.5 s, shows it, maps it to the clip
   that hosts it, and moves the playhead to Studio's time. Rows in the pane
   (or `1`–`9`) select a top-level clip without Studio.
4. **Cut with the CLI's own edits** (each one `hyperframes timeline …` call,
   undoable with `Undo`): `Trim in→┃` (`i`) starts the clip at the playhead;
   `┃←Trim out` (`o`) ends it there; `Split @┃` (`s`) makes `<id>-2`; `Move→┃`
   (`m`) keeps the length; `Duplicate` (`d`) makes `<id>-copy`; `Delete` (`x`);
   `Undo` (`u`) restores the previous pane edit (receipts in
   `<project>/.hyperframes/cutroom/`). Studio keeps its own undo for drags
   made there.
5. **Say it.** Just type in Claude Code's prompt: while a project is open and
   `prompt context` is on (`t` toggles it), every prompt you type carries the
   Studio selection, the hosting clip, the playhead, the snapshot path and a
   compact timeline, so "把這個標題放大" or "cut this scene 1s shorter" is
   enough. The `Ask Claude ›` box does the same from inside the pane. When the
   turn ends the pane reloads the timeline and the frame; Studio reloads itself.
6. `Check` (`c`) runs `hyperframes check --json`; `Render draft` (`v`) writes
   `renders/draft.mp4`; `Reload` (`z`) re-reads the timeline.

## Try it

1. Make a project if you have none: `npx hyperframes init demo`.
2. In Claude Code: `/cut demo`. Studio opens in the browser; the pane shows
   the first frame. Press `▶`, then click a clip in Studio's timeline and watch
   the pane follow.
3. Type in the prompt: "make the title 20% larger". Claude edits the
   composition; Studio and the pane reload.

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
- `claude plugin test .` runs the tests against the real engine, with the world
  beneath the plugin (fs, process, http, store, env, clock) answered by the
  tests: clips list, nested rows hidden, select, seek, `Split` reaching the CLI
  with the exact argv, a split outside the clip refused before anything runs;
  and with Studio mocked, the selection poll landing in the pane and riding the
  next typed prompt as context.
- Once loaded from a folder you own, the engine lays its API declarations under
  `.claude-plugin/types/`, and `tsc -p .` type-checks the mod.

## License

MIT, see [LICENSE](./LICENSE).
