/**
 * The gold button recipe — lifted verbatim from the Vault Setup mock. This
 * is the canonical primary button treatment app-wide: the exact surface
 * WelcomeScreen's "Get Started" button uses, and every other primary gold
 * button (onboarding and in-app alike) now matches it. See GoldButton.jsx
 * for how it's applied.
 *
 * The shine is two things working together:
 *
 *   1. a FOUR-stop vertical gradient, weighted toward the top. The stops are
 *      not evenly spaced (0 / 30 / 60 / 100) — that bunching is what reads as
 *      a curved metal surface catching light rather than a linear fade.
 *   2. a 1px white specular line along the top edge (the mock's
 *      `inset 0 1px 0 rgba(255,255,255,.6)`), which is what makes it look lit
 *      from above rather than merely coloured.
 *
 * CSS source (Vault Setup.html, "Create vault & unlock" button):
 *   background: linear-gradient(180deg,#f7d98d 0%,#e8bd63 30%,#cfa03c 60%,#b6852a 100%)
 *   color:#171208; font-weight:800; border-radius:99px; letter-spacing:-.01em
 *
 * `glow` used to be a warm amber drop-shadow spread onto every gold button
 * app-wide (`box-shadow: 0 10px 26px rgba(227,187,104,.28)` in the mock).
 * It's disabled here — zeroed rather than deleted, since dozens of call
 * sites still spread `...goldButton.glow` into their own style and this
 * keeps every one of them a no-op instead of requiring a matching edit.
 */
export const goldButton = {
  colors: ['#F7D98D', '#E8BD63', '#CFA03C', '#B6852A'],
  locations: [0, 0.3, 0.6, 1],
  start: { x: 0.5, y: 0 },
  end: { x: 0.5, y: 1 },
  specular: 'rgba(255, 255, 255, 0.6)',
  onGold: '#171208',
  glow: {
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
};
