# The desktop build

The game is a web page; this folder is the window. `main.js` serves `web/` over a loopback
port and points one Electron `BrowserWindow` at it — no node in the renderer, no remote
content, the same bytes the browser preview runs.

Releases are packaged with electron-packager for win32-x64 (see the release notes on
GitHub); the packaged app carries its own copy of `web/`, so a release folder is the
whole game.
