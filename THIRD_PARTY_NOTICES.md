# Third-party notices

## 5D Chess JS 1.2.1

- Authors: Shaun Wu; contributors include Shad Amethyst, SnowmanFactory, and Neathp.
- Source: https://gitlab.com/5d-chess/5d-chess-js
- License: AGPL-3.0-or-later. A copy is in `LICENSE` and in the installed package.
- Used for piece geometry, board transitions, notation, and built-in starting positions. The package is unmodified; local wrappers replace its eager complete-action search and timeout-based terminal detection.

Its installed dependency tree also includes `blueimp-md5` (MIT), `module-alias` (MIT), and `present` (MIT). Their license files are distributed with their npm packages. `package-lock.json` pins the resolved dependency tree.

No game artwork or proprietary Steam game files are included. The interface renders pieces with system Unicode glyphs.
