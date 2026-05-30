# Demo capture guide (screenshots)

The demo (`src/Demo.tsx`) renders end-to-end **right now** with on-brand
placeholders in the three product slots. The brand scenes (cold open, problem,
mastery ramp, constellation, CTA) are final. To finish it, drop real screenshots
of the **current** UI into `video/public/shots/` and flip each `available: true`
in the `CLIPS` object in `src/Demo.tsx`.

## Capture from a CLEAN profile (optional but nicer)

So the demo doesn't show dev/test clutter, launch the app with an isolated
user-data dir and stage one good source:

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
& "<path>\StarcallOS-0.1.0-portable-x64.exe" --user-data-dir="C:\tmp\sc-demo-profile"
```

## Screenshots to grab

Maximize the window. PNG, as high-res as you can (≥1920×1080). Capture the app
**content** (the OS title bar is fine to include or exclude — the demo wraps it
in its own window chrome). Keep each shot to one clean screen.

| File | Screen | Required |
|------|--------|----------|
| `candidates.png` | **Candidate Review** — the candidate list with rows, parser labels, score bars | yes |
| `promote.png` | A **promoted concept** (concept Overview) — or the promote action | yes |
| `challenge.png` | A **Challenge** showing a **grader verdict** (`understood` / `gap`) | yes |
| `map.png` | The real **Constellation Map** tab | optional |
| `annotations.png` | The **Annotations** tab (highlight + linked note) | optional |

Tip: shots are panned/zoomed (Ken-Burns), so a little headroom at top/bottom is
good. Avoid tiny modal screenshots — full-screen content reads best at 1080p.

## After capturing

1. Copy the PNGs into `video/public/shots/`.
2. In `src/Demo.tsx`, set `available: true` for each shot you added.
   (To wire `map.png` / `annotations.png`, add a `ClipScene` for them in the
   `SCENES` array — ask and I'll do it.)
3. Preview: `npm run dev` (Remotion Studio at the printed URL).
4. Render: `npm run render` → `out/demo.mp4`; `npm run render:gif` → `out/demo.gif`.
5. README's `![demo](docs/demo.gif)` expects the GIF copied to the repo's `docs/`.
