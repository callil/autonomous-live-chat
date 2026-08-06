# App Harness interface system

App Harness has two visual responsibilities that should never blur together:

1. The host application must remain useful, calm, and recognizably itself.
2. App Harness must feel like an optional instrument placed above the host, not permanent application navigation.

This document adapts the hierarchy, restraint, and token discipline described in [Vercel's design guidance](https://vercel.com/design.md) to this product. It does not copy Vercel branding. The relevant lesson is judgment: typography before decoration, one continuous canvas, boundaries only where they clarify interaction, and motion only where it explains state.

Two other references sharpen the split. [bb](https://github.com/get-bb/bb) informs the compact, stable operator rows inside Activity. Agentation informs the more important boundary: authoring is a floating layer over a host product, not navigation built into it. These are interaction references, not visual skins to reproduce wholesale.

## The demo's one job

The host is a live room. People open it to talk. They summon App Harness only when they want to point at the product, leave situated feedback, or ask the product to change itself.

The first viewport therefore prioritizes, in order:

1. The room and its messages.
2. The message composer.
3. One small App Harness launcher.

Activity, annotations, targeting controls, and implementation links are available on demand. They do not occupy a permanent sidebar, dashboard, rail, or status surface.

## Composition

```text
┌──────────────────────────────────────────────────────────┐
│ Main room                                      ● 4 live  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                conversation, one column                  │
│                                                          │
│             ┌────────────────────────────┐               │
│             │ Message the room       ↑   │               │
│             └────────────────────────────┘          [ ⌖ ] │
└──────────────────────────────────────────────────────────┘
                                                       │
                         optional App Harness layer ───┘
```

The host uses a centered reading column and one fixed composer. The launcher is the only persistent Harness element. Opening it reveals a compact instrument panel; choosing Activity replaces that panel with the shared ledger. Targeting and comments open a focused request surface near the launcher.

## Visual character

The host is quiet, monochrome, and editorial. App Harness is distinguished by behavior and a high-contrast black control, not by glossy effects or a second application shell. A single indigo state color identifies target outlines and canvas marks. It is never used as decoration.

- Canvas: `#ffffff`
- Primary text and controls: `#1d1d1f`
- Secondary text: `#686868`
- Subtle surface: `#fafafa`
- Boundaries: `#e7e7e7`
- Harness targeting state: `#5b5bd6`
- Success, warning, and failure colors appear only with a textual state.

Geist is the preferred interface face. Geist Mono is reserved for timestamps, counts, phases, and compact operational identifiers.

## Token contract

The demo reads from CSS custom properties in `apps/demo/public/app.css`; the reusable overlay uses the separate `--ah-*` contract in `packages/react/styles.css`. Repeated values must become a token before use.

Token families:

- `--color-*`: canvas, surfaces, text, borders, controls, focus, Harness state, and semantic status.
- `--font-*`, `--type-*`, `--weight-*`, `--leading-*`: typography roles.
- `--space-*`: the four-pixel spacing rhythm.
- `--radius-*`, `--shadow-*`: restrained shape and elevation.
- `--duration-*`, `--ease-*`: state continuity.
- `--z-*`: canvas, target composer, overlay, and toast ordering.
- Named dimensions such as `--content-width`, `--composer-width`, `--launcher-size`, and `--overlay-width`.

Do not introduce an isolated hex color, shadow recipe, animation duration, z-index, recurring gap, or recurring radius in a component rule. Extend the root system instead.

## Host components

### Room header

The header contains the room identity and truthful realtime connection state. It is a header, not navigation. The state is text plus a dot so color is never the only signal.

### Conversation

Messages use one shared vertical rhythm. Author and time are compact metadata; message text receives the visual priority. Avatars are quiet orientation aids, not decorative badges.

### Composer

The composer is the strongest permanent control. It has one earned boundary and a restrained shadow so it remains legible above moving conversation content. Enter sends; Shift+Enter adds a line; disabled state remains visually and semantically explicit.

## Harness components

### Launcher

One high-contrast square button summons or dismisses App Harness. A numeric badge appears only when durable work needs representation. Its color always accompanies a count and the Activity ledger contains the textual state.

### Instrument panel

The panel contains Target, Comment, Draw, and Activity. It is compact, dismissible, and keyboard accessible. Selected tools invert rather than gaining decorative color or depth.

### Target composer

The composer names the selected element and asks for one request. Submission acknowledgement remains visible until the user chooses Done. The UI must never claim building, completion, a GitHub issue, or a pull request before the durable ledger reports it.

### Activity and marks

Activity is one on-demand panel containing truthful work state, issue and pull-request links, and canvas-mark management. Individual marks can be removed; room marks can be cleared after confirmation. Chat messages are never affected by clearing annotations.

## Interaction rules

- The Harness layer is absent from the visual flow while closed.
- Escape leaves the current authoring mode before dismissing the layer.
- Target and comment modes intercept only opted-in `data-target-id` elements.
- Target envelopes keep stable selectors and safe labels; they never capture message bodies, form values, query strings, or secrets.
- Motion confirms opening, closing, and icon continuity only. Reduced-motion preferences remove it.
- Focus remains visible on every interactive control.
- Narrow screens preserve the chat and composer first; Harness surfaces stay within the viewport and move above the composer.

## Restraint checklist

Before shipping a UI change, remove any element that does not improve orientation, action, state, or auditability. In particular, reject:

- permanent operator sidebars, activity dashboards, and authoring rails;
- gradients, glows, glass effects, decorative blur, and ornamental badges;
- cards nested in cards;
- icons that do not make an action faster to recognize;
- animation that does not explain a state transition;
- labels that describe implementation rather than what a person can do;
- status copy that gets ahead of the durable system record.
