# Accessibility Plan

Branch: `a11y-audit-2026-05-04`

## Implemented in this branch

- Desktop launchers now expose button semantics, controlled-window relationships, focus styling, and open-state updates.
- Main windows and overlays now expose dialog/region semantics, labelled headers, progressbar state, and busy/live announcements.
- Results, saved spots, popup actions, and toggle buttons now expose keyboard activation and `aria-pressed` state without losing visible text.
- Radio Reach now labels its form controls from the existing translated UI text, exposes progress/busy state, and makes help popovers/tooltips announce correctly.
- The globe location chip is now a real button and mirrors its settled location text onto the globe graphic.
- Rocky's desktop toggle now exposes pressed state and supports keyboard activation.

## Remaining accessibility work

- Run a keyboard-only pass on both maps. Leaflet itself is only partially accessible, so drawing, editing, and map inspection still need a non-pointer fallback strategy.
- Review focus management for overlapping modeless windows. The current branch improves focus targets, but it does not implement a full desktop-window navigation model.
- Add automated checks to CI or local review: Axe, Lighthouse, and an HTML validator pass.
- Do a manual screen-reader pass in at least NVDA/Firefox and VoiceOver/Safari or Orca/Firefox for the main search flow, saved spots flow, and Radio Reach flow.
- Audit color contrast, reduced-motion behavior, and pointer target size. This branch focused on semantics and runtime state, not visual contrast tuning.

## Manual verification checklist

- Tab through desktop icons, titlebar buttons, results cards, popup actions, and radio controls.
- Confirm `aria-expanded` changes on desktop launchers and sidebar toggles.
- Confirm `aria-pressed` changes on love/star toggles and Rocky.
- Confirm progress dialogs announce phase changes and expose numeric progress.
- Confirm radio help `?` buttons expose tooltip text on focus and clear that association on blur.