# OpsNest system icons

This directory contains optional system and firmware icons that OpsNest can load after installation without requiring a new desktop release.

## File convention

- Use lowercase kebab-case names, for example `debian.svg`, `openwrt.svg`, and `fnos.svg`.
- Version-specific icons may use `name@major.minor.svg` when a release needs a distinct mark.
- Files must be SVG documents with a `viewBox="0 0 24 24"`.
- Keep the artwork readable at small sizes and use `currentColor` where practical.
- Record the source and license for third-party artwork in the repository documentation.

OpsNest checks its local cache first, then tries the matching version-specific icon and the generic icon from this directory. A missing icon never prevents a server page from rendering; the bundled system icon remains the offline fallback.
