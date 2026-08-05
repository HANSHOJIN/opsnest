# CodexShell aesthetic baseline for OpsNest V2

This document is a design baseline and review aid for the V2 application. It is derived from the copied CodexShell `0.1.1` implementation in `src/App.tsx`, `src/components/ShellLayout.tsx`, and `src/styles.css`.

Software requirements are the primary decision criterion. These rules express the default CodexShell character and should be preserved when they fit the product. They are not immutable restrictions: a feature may intentionally deviate when usability, accessibility, platform behavior, or a concrete OpsNest requirement justifies it.

When a design changes a shell-level convention, record the reason, the affected areas, and which surrounding conventions remain intact. This keeps the product coherent without blocking necessary evolution.

## Shell identity

- The window is a quiet desktop workbench, not a marketing dashboard.
- The four-pane relationship is the default composition: left navigation, inset center work area, right utility panel, and optional bottom panel. A product requirement may introduce another composition when the reason is explicit.
- The shell owns window chrome, pane geometry, resize handles, collapse states, settings entry, tray behavior, and motion.
- OpsNest owns the content rendered inside `left`, `main`, `right`, `bottom`, and settings slots.
- Business features should not replace the shell with a full-screen page, a second app bar, or a competing navigation rail unless the product requirement calls for it and the tradeoff is understood.

## Geometry and rhythm

These are the current shell anchors. Treat them as defaults and starting points, not immutable values:

| Element | Baseline |
| --- | --- |
| Window chrome | 30px |
| Center toolbar | 52px |
| Other panel toolbars | 48px |
| Left panel default | 260px |
| Right panel default | 300px |
| Bottom panel default | 210px |
| Minimum side panel | 190px |
| Minimum bottom panel | 120px |
| Shell minimum | 680 × 460px |
| Window minimum | 760 × 520px |
| Center top-left radius | 14px with a 6px inset |

Use the existing CSS grid and resize handles where they fit. Avoid ad hoc fixed overlays or a competing responsive grid unless the feature genuinely needs one.

## Color and contrast

The palette is low-saturation and layered rather than brightly branded:

- Dark shell background: `#171717`
- Dark sidebar panel: `#241e1f`
- Dark center paper: `#171717`
- Dark bottom panel: `#151515`
- Strong text: `#f1f1f3`
- Chrome text: `#bdbdc2`
- Muted text: `#96969b`
- Soft border: `#2a2a2d`
- Border: `#343438`
- Hover: `rgba(255, 255, 255, .08)`
- Focus ring: `#6b8afd`
- Destructive close hover: `#b43b4a`

The light theme uses the same hierarchy with pale neutral and very light warm-pink surfaces. New feature colors should be semantic and quiet by default. Neon accents, large saturated gradients, colored dashboard tiles, or a new brand color are acceptable only when they serve a clear product or accessibility need.

The translucent sidebar effect is intentionally restrained: a soft warm ambient gradient, blur, and saturation are limited to the sidebar treatment. Do not spread glass effects across every card or content surface without a clear reason.

## Typography

- Base family: `Noto Sans SC Variable`, with system fallbacks.
- App title may use `Segoe UI Variable` before the CJK fallback.
- Base UI size is controlled by `--ui-font-size`, defaulting to 14px and allowing 13–15px.
- Common UI text is 11–14px; compact labels stay compact.
- App/panel title is approximately 15px; the settings page heading is 28px.
- Weight range is restrained, roughly 450–650. Use weight to establish hierarchy instead of oversized text.
- Keep line lengths and whitespace calm. Do not fill the shell with oversized hero headings or dense all-caps labels.

## Shape, borders, and elevation

- Window controls are transparent until hover.
- Icon buttons are compact, generally 26–30px, with 6–7px rounding.
- Navigation items use approximately 7px rounding and short 29–32px rows.
- Small popovers use approximately 8px rounding and a quiet shadow.
- Theme cards use 12px rounding; the settings card uses 16px rounding.
- Borders are one-pixel, low-contrast separators. Shadows are reserved for floating popovers and restore affordances.
- Avoid pill-shaped UI except for the toggle control or a clearly semantic status chip.
- Avoid heavy outlines, thick separators, skeuomorphic surfaces, and nested card stacks.

## Motion and interaction

- Panel and layout transitions use short, quiet easing: approximately 140ms for controls, 180ms for opacity, 220ms for navigation groups, and 260ms for pane geometry.
- Dragging disables layout transitions so resizing feels direct.
- Every collapsible or resizable panel needs a visible control and keyboard behavior where the shell already provides it.
- Respect both the explicit `reduce-motion` preference and `prefers-reduced-motion`.
- Hover should reveal affordances without making the interface pulse, bounce, glow, or continuously animate.
- Use Lucide-style line icons at the existing compact sizes; do not introduce a separate icon family for feature panels.

## Content integration rules

- Put server navigation in the left slot, the active server/workspace in the center slot, files or contextual utilities in the right slot, and live terminal/session output in the bottom slot unless a deliberate shell-level decision changes that contract.
- Reuse the shell toolbar, panel toolbar, separators, and existing token variables before adding a feature-specific surface.
- Feature cards should be information-dense but quiet: title, status, metadata, and one clear action.
- Prefer inline states, compact rows, timelines, and expandable details over dashboard mosaics.
- A terminal remains a terminal view; chat, AgentRun explanations, raw output, approval, and verification should be distinguishable without turning the terminal into a chat bubble layout.
- Settings and operational content should preserve the shell's centered, bounded reading width and restrained section spacing.

## Default anti-patterns, not absolute prohibitions

These patterns are normally poor fits for the shell and should trigger a design review. They may be used when a concrete requirement outweighs the baseline, but the deviation should be documented:

- Replacing the four-pane shell with a top-nav web dashboard.
- Adding a second custom title bar or window-control cluster.
- Copying the old OpsNest navigation, page chrome, or screenshot-specific layout into V2.
- Introducing saturated blue/purple gradient backgrounds, giant hero cards, or glassmorphism across the whole app.
- Using large rounded cards for every row or turning every status into a colored badge.
- Mounting feature-specific global CSS that changes `body`, shell grid geometry, shared typography, or token meaning without a shell-level review.
- Making panel collapse, settings, tab changes, or hidden views destroy a live SSH/PTTY session. This remains a lifecycle correctness issue, not merely a visual preference.

## Review checklist

Before accepting a new V2 screen or component, check:

- [ ] Its visual decisions are traceable to a product, usability, accessibility, or shell-consistency reason.
- [ ] It is rendered inside an existing shell slot or an explicitly approved shell extension, unless a new composition is required.
- [ ] It uses the existing typography, color variables, icon family, borders, radii, and motion durations where appropriate.
- [ ] It preserves the 30px chrome, 48/52px toolbar rhythm, and pane geometry unless a documented requirement supports changing them.
- [ ] It remains legible in both light and dark themes.
- [ ] It has a quiet empty/loading/error state instead of a decorative dashboard treatment.
- [ ] It respects reduced motion and keyboard focus behavior.
- [ ] It does not create a second navigation model or window chrome without documenting why the product needs it.
- [ ] It does not couple visual mounting to SSH/PTTY session lifetime.
