---
name: Recruvault
description: Secure, audited exchange for cleared and government-adjacent hiring
colors:
  paper: "oklch(0.985 0.006 75)"
  ink: "oklch(0.24 0.014 60)"
  accent-oxblood: "oklch(0.46 0.132 24)"
  accent-oxblood-hover: "oklch(0.4 0.13 24)"
  accent-tint: "oklch(0.955 0.028 30)"
  accent-tint-border: "oklch(0.88 0.05 28)"
  neutral-50: "oklch(0.985 0.002 75)"
  neutral-100: "oklch(0.97 0.003 75)"
  neutral-200: "oklch(0.923 0.004 75)"
  neutral-300: "oklch(0.869 0.005 75)"
  neutral-400: "oklch(0.709 0.008 65)"
  neutral-500: "oklch(0.553 0.01 60)"
  neutral-700: "oklch(0.374 0.01 58)"
  neutral-900: "oklch(0.216 0.008 58)"
  status-open: "oklch(0.7 0.15 155)"
  status-closing: "oklch(0.77 0.14 80)"
  status-closed: "oklch(0.63 0.2 25)"
  status-info: "oklch(0.68 0.13 235)"
typography:
  display:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
    fontFeature: "tnum"
rounded:
  sm: "6px"
  md: "8px"
  full: "9999px"
spacing:
  card: "20px"
  section-gap: "24px"
  field-gap: "12px"
components:
  button-primary:
    backgroundColor: "{colors.neutral-900}"
    textColor: "{colors.neutral-50}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "40px"
  button-accent:
    backgroundColor: "{colors.accent-oxblood}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "#ffffff"
    textColor: "{colors.neutral-700}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "40px"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.neutral-900}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "40px"
  card:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "{spacing.card}"
  badge-status:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent-oxblood}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
---

# Design System: Recruvault

## 1. Overview

**Creative North Star: "The Compliance Ledger"**

Recruvault handles the most sensitive moment in hiring: a cleared candidate handing over clearance levels, identity documents, and right-to-work evidence. The interface has to feel like the physical thing it replaces at its best, a well-kept compliance ledger on good paper, not a consumer app and not a dark ops console. A recruiter or compliance officer reads it at a desk in daylight, scanning dense records and needing to trust every row. So the system is warm, quiet, and dense: paper-tinted neutrals, ink-black text, tabular figures, and a single deep oxblood accent that appears only where attention is earned.

Warmth is the strategic choice. Cool slate and corporate navy read as generic SaaS; a warm stone palette with an oxblood accent reads as considered, institutional, and human without being soft. The accent is rationed, not sprayed: it marks the brand, active navigation, links, focus, and selection, and nothing else. Everything structural is carried by hairline borders and tonal layering, not shadow or color.

The system explicitly rejects: dark mode (recruiters work in daylight and the product ships no dark variants), purple or blue "trust-me" SaaS gradients, glassmorphism, hero-metric dashboards, and decorative motion. Familiarity is a feature here; the tool should disappear into the task.

**Key Characteristics:**
- Warm paper neutrals (stone ramp), ink-black text, never pure `#000`/`#fff`
- One rationed accent: deep oxblood, used on roughly 5% of any screen
- Dense, legible, tabular data with hairline borders over shadows
- Institutional crispness: tight 6–8px radii, restrained 150ms state motion

## 2. Colors

A warm, low-chroma palette: paper and ink for the field, oxblood for the single voice of emphasis, and muted semantic status colors for record state.

### Primary
- **Oxblood** (`oklch(0.46 0.132 24)`): the sole brand accent. Brand mark, active/hover navigation, links, focus rings, selection highlight, and status dots for critical records. Its hover is a deeper oxblood (`oklch(0.4 0.13 24)`).
- **Oxblood Tint** (`oklch(0.955 0.028 30)`): a barely-there wash behind accent chips and the empty-state icon; paired with a `oklch(0.88 0.05 28)` hairline.

### Neutral
- **Warm Ink** (`oklch(0.24 0.014 60)`): default body text and the primary (ink) button fill.
- **Warm Paper** (`oklch(0.985 0.006 75)`): the app background. Cards sit a step brighter on white.
- **Stone ramp** (`stone-50` through `stone-900`): every gray in the system is a warm stone, never a cool zinc. Borders `stone-200`, dividers `stone-100`, muted text `stone-500`, placeholders `stone-400`.

### Tertiary (status)
- **Open / Clean Green** (`oklch(0.7 0.15 155)` dot, `emerald-50/800` chip): active, healthy records.
- **Closing Amber** (`oklch(0.77 0.14 80)` dot, `amber-50/800` chip): time-sensitive records.
- **Closed / Failed Red** (`oklch(0.63 0.2 25)` dot, `red-50/800` chip): terminal or failed records.
- **Info Blue** (`sky-50/800` chip): received/opened notices only.

### Named Rules
**The Rationed Voice Rule.** Oxblood appears on no more than ~5% of any screen. It is never a fill for primary buttons (those are ink), never a background panel, never decoration. If a second element on the screen is oxblood for emphasis, one of them is wrong.

**The Warm-Only Rule.** Every neutral tilts warm. `zinc`, `slate`, `gray`, and `#000`/`#fff` are forbidden; use the `stone` ramp and the paper/ink tokens.

## 3. Typography

**Display / Body Font:** Geist Sans (with `ui-sans-serif, system-ui, sans-serif`)
**Data / Mono Font:** Geist Mono (with `ui-monospace, monospace`)

**Character:** One neutral, technical grotesque carries the whole product, headings through labels. Its companion mono is reserved for machine data (record ids, audit sequence numbers, hashes). Numbers are always tabular so columns and dates align down a ledger.

### Hierarchy
- **Display** (700, 2rem / `text-2xl`, -0.02em, line-height 1.15): page titles only ("Requests", "Organisation settings").
- **Title** (600, 0.9rem, -0.01em): card section headers, sitting above a hairline divider.
- **Body** (400, 0.875rem, line-height 1.5): default text; prose capped at 65–75ch.
- **Label** (500, 0.875rem, `stone-700`): form field labels, one line above the control.
- **Data** (Geist Mono, 0.8125rem, tabular): ids, sequence numbers, hashes.

### Named Rules
**The Tabular Figures Rule.** Any surface that shows numbers as data (tables, submission counts, dates, retention days, audit sequences) uses `font-variant-numeric: tabular-nums`. Applied by default to `table` and the `.tnum` utility.

## 4. Elevation

Near-flat by doctrine. Depth comes from tonal layering (paper behind, white cards in front) and hairline `stone` borders, not from shadow. Cards carry only a whisper of ambient shadow to lift them off the paper; there is no elevation on hover beyond a border and background-tint shift. The sticky top bar is a translucent warm panel (`stone-50/85` + backdrop blur) so content scrolls under it without a hard seam.

### Shadow Vocabulary
- **Card rest** (`box-shadow: 0 1px 2px rgba(41,37,36,0.04), 0 1px 1px rgba(41,37,36,0.03)`): the only ambient shadow, a warm-tinted 1px lift.
- **Control** (`shadow-sm`): buttons and inputs, for a subtle tactile edge.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. State (hover, focus) is expressed with border and background changes, never a growing drop shadow. If a card lifts 8px on hover, it is wrong.

## 5. Components

### Buttons
- **Shape:** gently crisp corners (6px, `rounded-md`), 40px tall (default), `h-8`/`h-11` for sm/lg.
- **Primary (ink):** `stone-900` fill, `stone-50` text, hover `stone-800`. The default for almost every action.
- **Accent (oxblood):** oxblood fill, paper text, hover deeper oxblood. Reserved for the single most consequential action on a surface; most screens use none.
- **Secondary:** white fill, `stone-300` border, `stone-800` text, hover `stone-50` + `stone-400` border.
- **Ghost:** transparent, `stone-600` text, hover `stone-100`. **Link:** oxblood text, underline on hover.
- **Focus:** 2px oxblood outline, 2px offset, on every variant.

### Cards / Containers
- **Corner Style:** 8px (`rounded-lg`).
- **Background:** white on warm paper.
- **Shadow:** the single "Card rest" ambient shadow (see Elevation).
- **Border:** 1px `stone-200`.
- **Header:** an optional titled header (`CardHeader`) sits above a `stone-100` divider, giving the ledger its sectioned feel. Internal padding 20px (`p-5`).

### Inputs / Fields
- **Style:** white fill, 1px `stone-300` border, 6px radius, `shadow-sm`, 40px tall.
- **Focus:** border shifts to oxblood with a soft oxblood outline (`outline-accent/40`); no glow.
- **Label:** 500-weight `stone-700`, 6px above the control.

### Badges
- **Style:** pill (`rounded-full`), 1px border, warm tinted fill, 12px medium text.
- **Status:** green/amber/red/blue map to record state via `statusBadgeVariant()`; a matching solid dot precedes list rows.
- **Accent:** oxblood text on oxblood tint with a tint border, for brand-emphasis chips.

### Navigation
- **Style:** sticky translucent warm bar (`stone-50/85` + blur), hairline bottom border.
- **Brand:** oxblood `ShieldCheck` mark + ink wordmark.
- **Links:** 500-weight `stone-600`, hover oxblood. Org · role sits right, muted, role capitalized.

### List Row (signature)
A request row is a full-width card: a leading status dot (colored by state), title in ink, tabular metadata line (submissions · expiry · listed), a status pill, and a muted chevron. Hover shifts border to `stone-300` and background to `stone-50/60`. This is the workhorse pattern for scanning records.

## 6. Do's and Don'ts

### Do:
- **Do** keep every neutral warm: use the `stone` ramp, `paper`, and `ink` tokens.
- **Do** ration oxblood to brand, active nav, links, focus, selection, and status dots, roughly ≤5% of a screen.
- **Do** use tabular figures (`.tnum` / `table`) for all numeric data so ledgers align.
- **Do** express hover/focus with border and background shifts and a 2px oxblood focus outline.
- **Do** give empty states an accent icon, a teaching sentence, and a primary action.

### Don't:
- **Don't** ship dark mode or honour `prefers-color-scheme`; the product is light-only and mixing broke the whole UI once already.
- **Don't** use `zinc`, `slate`, `gray`, `#000`, or `#fff`; they read cold against the paper.
- **Don't** fill primary buttons with oxblood; primary is ink, oxblood is the rationed accent.
- **Don't** reach for purple/blue "trust" gradients, glassmorphism, hero-metric tiles, or identical icon-card grids.
- **Don't** grow drop shadows on hover or animate layout properties; state is border and background, motion is ≤150ms.
- **Don't** use em dashes in UI copy; use commas, colons, or periods.
