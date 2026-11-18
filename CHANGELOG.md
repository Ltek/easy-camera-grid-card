# Changelog

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
