# Changelog

## v2026.11.18.3

- **Visual editor redone to the Ltek card design.** Four panels (Cameras, Grid tiles, Large pane, Layout) with the
  same look as the other Ltek cards. Cameras are a list with ↑ ↓ ✏️ 🗑: ✏️ opens a camera's own name, tile, refresh
  and fit. Sizes, columns, rows, gap and times are sliders. Landscape and Portrait each have their own sub-panel.
  "Go back" is one checkbox with its time beside it.
- Editing layout, refresh, fit or go-back no longer restarts the live stream in the preview; the camera you tapped
  stays live when the editor rebuilds the card.

## v2026.11.18.2

- A tile whose snapshot doesn't load now says **No picture** instead of staying blank, and keeps trying at its
  refresh interval. The message goes away as soon as a picture loads. (Blank tiles were Blue Iris snapshots
  that came back as a login page; Blue Iris (Ltek) 2026.11.18.47 fixes that side.)

## v2026.11.18.1

- First build. One camera plays live in a large pane; every other camera is a JPEG snapshot tile, refreshed
  every 2 seconds. Tap a tile to make that camera the live one; the previous camera goes back to its spot in
  the grid.
- Landscape (pane left or right) and portrait (pane top or bottom), each with its own pane size, grid columns
  and rows. Follows the screen when the tablet is turned, or can be fixed to one orientation.
- Per-camera tile settings: snapshot or live, refresh interval, fit. Card-wide defaults for all of them.
- Choose the camera that starts in the pane and the order of the grid. Optional "go back" timeout.
- Fills the rest of the screen by default (`height: fill`), or any CSS height.
- Streams and snapshots stop while the card or the page is hidden.
- Visual editor for every setting.
