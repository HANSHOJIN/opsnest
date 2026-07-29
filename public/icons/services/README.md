# OpsNest service icons

This directory is an optional, remotely extensible icon catalog for OpsNest.

## File convention

- Use lowercase kebab-case names, for example `nginx.svg`, `open-list.svg`, and `1panel.svg`.
- Version-specific icons may use `name@major.minor.svg`, for example `nginx@1.26.svg`.
- Files must be SVG documents with a `viewBox="0 0 24 24"`.
- Keep the artwork readable at small sizes and use `currentColor` where practical.
- Add the source and license information in the SVG or in the repository documentation when the artwork is derived from another project.

OpsNest checks its local cache first, then tries the matching version-specific icon and the generic icon from this directory. If the network is unavailable or an icon is missing, the desktop application keeps using its bundled fallback icon.
