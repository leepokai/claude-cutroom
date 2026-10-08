# claude-mod-cutroom

**Cutroom** is a preview and timeline for [HyperFrames](https://hyperframes.heygen.com)
videos that lives inside Claude Code. `/cut` opens it beside the transcript: the
video plays live in the pane, and under it one track cut by time into segments,
each showing its real frames. No browser and no HyperFrames Studio.

You change the video by talking to Claude in the same window. Click a segment
first and whatever you type carries it ("this part"), the playhead, a snapshot
of the frame and the timeline, so "make this title bigger" needs no pointing.

```
demo  10s                                                   [Export]
┌──────────────────────────────────────────────────────────────┐
│          (the video, playing live; tap it to play/pause)     │
└──────────────────────────────────────────────────────────────┘
00:03.2 / 00:10.0         ⏮  −1s  ▶  +1s  ⏭                ● Live
0s            2.5s             5s             7.5s             10s
╭─ Intro ───────╮╭─ Graphics ─────────────────────────────────╮
│ frames  2.5s  ││ frames                                 7.5s│
╰───────────────╯╰────────────────────────────────────────────╯
Graphics, 2.5-10s selected. Tell Claude what to change.
```

Segments: every clip edge is a cut, and each piece is named for the shortest
clip covering it, the most specific content there.

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

1. `/cut` in a HyperFrames project (or `/cut <dir>`). With `hyperframes.json` in
   the cwd the pane opens by itself at session start.
2. **Watch.** Tap the video (or `▶`) to play or pause; `⏮ −1s +1s ⏭` step.
3. **Point.** Click a segment to select it and put the playhead there; drag
   along the track to scrub, the preview follows.
4. **Change it** by telling Claude in the chat; when the turn ends the pane
   reloads the timeline, the frames and the player.
5. `Export` renders `renders/draft.mp4`.

## Layout

A Claude Code mod is three files plus a type contract (see the
`plugin-authoring` skill inside Claude Code). This repo is one such mod and
doubles as its own plugin marketplace.

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   lets `claude plugin marketplace add` point here
hooks/hooks.json                  names the hooks module
hooks/timeline.tsx                the timeline's pointer (and its text drawing in a terminal)
hooks/tap.tsx                     tap-to-play over the preview
hooks/register.tsx                the whole mod: CLI runner, state atoms, edit
                                  verbs, live player bridge, prompt composer, Pane render
player/cutroom-player.mjs         plays the composition in headless Chrome, serves frames
types/index.d.ts                  the $.state contract the pane draws from
tests/editor.test.tsx             claude plugin test .
```

- `claude plugin validate .` lists every hook and `$` call the engine will see.
- `claude plugin test .` runs the tests against the real engine, with the world
  beneath the plugin (fs, process, http, store, env, clock) answered by the
  tests: clips list, nested rows hidden, select, seek, `Split` reaching the CLI
  with the exact argv, a split outside the clip refused before anything runs;
  the selected clip and playhead riding the next typed prompt; and the live
  player's frames reaching the pane on the desktop and in a terminal.
- Once loaded from a folder you own, the engine lays its API declarations under
  `.claude-plugin/types/`, and `tsc -p .` type-checks the mod.

## License

MIT, see [LICENSE](./LICENSE).
