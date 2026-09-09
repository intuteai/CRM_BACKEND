# PDI Generic Fill-Out Form — UX Redesign — Design Spec

**Date:** 2026-09-09
**Status:** Approved for implementation

## Problem

`GenericPdiGeneratorForm.jsx` (CRM) works, but is hard to use: every section of every page is stacked in one long scroll inside a modal, there's no indication of what's filled in vs still empty, table rows are dense/fiddly, and the whole thing looks visually flat. This redesigns the fill-out experience to be full-page, section-at-a-time, with a persistent progress-aware sidebar, autosave, undo-able deletes, a pre-finalize completeness check, and drag-and-drop photo upload — while reusing the existing section-rendering logic and data contracts almost entirely as-is.

This was brainstormed visually (mockups compared side-by-side); the chosen direction for each decision point is recorded below without re-litigating the alternatives.

## Scope

**In scope:**
- `GenericPdiGeneratorForm.jsx` — restructured from "landing card + modal" to "landing card + full-page fill-out view," same route (`/pdi-generator/:templateId`), same component.
- A new sidebar navigator component showing every section (flattened across all of a template's `pages`) with a filled/unfilled indicator, plus a virtual "Review & Finalize" entry.
- Autosave (two independent channels: form-field data, and photos), replacing "you must remember to click Save" as the primary save model.
- Undo-able row/photo deletion (local toast with a 5s undo window), replacing instant unrecoverable removal.
- A completeness check before Finalize, redirecting to the Review entry when sections are still empty instead of submitting blind.
- Table section visual refinement (roomier layout, GO/NG/NA becomes a 3-way button toggle instead of a `<select>`).
- Drag-and-drop file drop added to `ImageUploadCard` (`src/components/shared/PdiImageUpload.jsx`) — a shared component also used by `PDIGeneratorForm.jsx` and `AutoNXTGeneratorForm.jsx`, so those two forms incidentally gain drag-and-drop too, as a side effect of touching shared code, not a scope expansion into redesigning them.

**Explicitly out of scope:**
- `PDIGeneratorForm.jsx` (General) and `AutoNXTGeneratorForm.jsx` (AutoNXT) are not restructured or restyled. They keep their existing modal-based layout.
- No true per-field "required" validation. The template dialect has no concept of a required field today (only `pdi_no` is hard-required, enforced by the PDF generator itself, unrelated to what a template's author defines). The "filled/unfilled" indicator introduced here is a section-level heuristic ("has at least one value"), not field-level validation, and is informational only — it never blocks Save, and only soft-blocks Finalize (see Review & Finalize below).
- No offline support, no real-time multi-user collaboration on the same report.
- No changes to the backend PDF-generation path (`renderer.js`, `authoredTemplate.js`, `pdi_generator.js`) or to the report data model — this is entirely a fill-out UX change. The existing `PATCH /api/pdi/reports/:id` endpoint already supports the two-channel autosave design below with zero backend changes (confirmed: `patchReport` treats `data` and `photos` as independent, individually-optional columns).

## Architecture: full page, not a modal

Today: clicking the landing card's "+ Create PDI" opens `react-modal` on top of it. New: clicking it swaps the landing card out for a full-page fill-out view, rendered by the same component in the same route (no new route, no `react-router` navigation). This is a local `isOpen`-style state toggle exactly like today, just rendering a different subtree instead of a `<Modal>`.

Resuming a draft (the existing `?report=<id>` query-param flow from the dashboard's Resume action) goes straight into this same full-page view once the report loads, exactly as it goes straight into the modal today.

## Flattened section list

`definition.pages` is flattened once (on definition load) into a single ordered array of `{ pageIdx, sectionIdx, section }` entries — one per section across every page. "Pages" stop being a form-filling concept entirely; they remain meaningful only inside `renderer.js` at PDF-generation time, which this redesign does not touch.

Each flattened entry is keyed by `${pageIdx}-${sectionIdx}` (stable for the lifetime of one definition load — not derived from `dataKey`, since nothing guarantees `dataKey` uniqueness across sections).

**Sidebar label per entry** (`sectionLabel(section)`), since not every section type has an author-settable title in today's dialect:
- `header` → `"Header"`
- `table` → `section.title || "Table"`
- `photo` → `"Photos"`
- `image` → `section.title || "Image"`
- `signature` → `"Signatures"`
- `text` → `section.label || "Notes"`

If two or more flattened entries resolve to the exact same label (whether both fell back to the same default, or both used the same custom title), append a disambiguating suffix in order of appearance: `"Table"`, `"Table (2)"`, `"Table (3)"`, etc.

## Completion heuristic

A section counts as **filled** if, per type:
- `header` — any `infoFields` entry's `leftKey`/`rightKey` value is non-empty.
- `table`, `mode: 'repeatable'` — `data[dataKey].length > 0`.
- `table`, `mode: 'fixed'` — at least one `fixedRows[].key` has a non-empty value for at least one `sectionData`-sourced column.
- `photo`, freeform or fixed-slots — at least one entry/slot has a non-null image.
- `image` — `data[dataKey]` is non-null.
- `signature` — any role's value is non-empty (trimmed).
- `text` — `data[dataKey]` is non-empty (trimmed).

This same function backs the sidebar's per-section indicator, the overall progress bar (filled count / total count), and the Review & Finalize summary.

## Sidebar navigator

Fixed-width left column, persistent for the whole full-page view:
- Template name at top.
- Thin progress bar: filled sections / total sections.
- One row per flattened section: label, filled/unfilled indicator (checkmark vs. empty dot), highlighted when active.
- One additional row at the bottom, visually separated (divider) from the real sections: **"Review & Finalize"** — a virtual entry, not counted in the progress bar's total.
- Every row is always clickable — navigation is never gated by completion or by visiting sections in order.

## Content area

Shows exactly one flattened entry's section at a time (whichever is active), rendered by the existing per-type functions (`HeaderSection`, `RepeatableTableSection`, `FixedTableSection`, `FreeformPhotoSection`, `FixedSlotPhotoSection`, `ImageSection`, `SignatureSection`, `TextSection`) — these keep their current props/behavior; only their visual styling and container change, not their field-handling logic.

- **PDI No.** stays a persistent field, but moves to the top bar (alongside the template name and the autosave status indicator) rather than living inside the modal body — it's required for every report regardless of which section is active.
- **Table refinement**: increased row/cell padding, larger inputs. The existing GO/NG/NA detection (`['GO','NG','NA'].includes(default.toUpperCase())`) now renders a 3-button toggle group instead of a `<select>`, same underlying value/`setCell` contract.
- **Bottom bar** (persistent, independent of active section): `Save Progress` (manual force-save, see Autosave) · `Back` (exits to the landing card — same cleanup as today's modal close: deletes the draft report if it was never successfully saved, see `hasSaved` under Autosave) · `Finalize & Generate PDF` (see Review & Finalize) — plus small `← Previous` / `Next →` buttons that step through the flattened list as a convenience shortcut, not a gate.

## Autosave

Two independent channels, both PATCHing `/api/pdi/reports/:reportId`:

1. **Data channel**: any change to a header/table/text/signature/`pdi_no` field marks the data channel dirty; after 1.5s of no further data-field changes, sends `PATCH { data, status: 'In Progress', inspected_by, inspection_date }` (no `photos` key — omitted fields are left untouched by `patchReport`). A change arriving while a save is already in flight schedules exactly one more save after the in-flight one resolves (no unbounded queueing).
2. **Photos channel**: any photo/image mutation (add, remove-confirmed — see Undo below, crop applied, slot image set/cleared) immediately sends `PATCH { photos }`, independent of the data channel's debounce.

**Status indicator** (top bar, next to PDI No.): `Saving…` while either channel has a request in flight, `All changes saved` once both are idle with nothing pending, `Unsaved changes` during the data channel's debounce window, `Couldn't save — retrying` on a failed request (retried on the next triggering change; no manual retry button needed since any further edit re-triggers the debounce).

**Manual "Save Progress"** button: force-flushes both channels immediately regardless of debounce state, using today's combined payload shape (`{ data, photos, status, inspected_by, inspection_date }` in one request) — kept as a simple, reliable "make sure this is saved right now" affordance.

`hasSaved` (which today gates whether closing without saving deletes the draft report) becomes true the moment *either* channel completes its first successful save, not only on a manual Save click — this keeps the existing "delete an abandoned, never-saved draft on exit" cleanup correct under autosave.

## Undo-able delete

Applies to the two removable-list UIs: repeatable table rows, and freeform-photo entries. Clicking remove:
1. Removes the item from `form` state immediately (so it's instantly gone, and naturally excluded from whatever the next autosave sends — no separate "pending deletion" state to track).
2. Shows a small local toast fixed at the bottom of the viewport: `"Row removed · Undo"` / `"Photo removed · Undo"`, holding the removed item and its original index.
3. If "Undo" is clicked within 5s, the item is reinserted at its original index and the toast dismisses. Otherwise the toast auto-dismisses after 5s and the removal is final.

This is local component state within `GenericPdiGeneratorForm.jsx` — not routed through the app's shared `useNotify`/Redux notification system, which only supports plain-text messages with no action button.

Fixed-slot photos and images (`ImageSection`, `FixedSlotPhotoSection`) keep their existing immediate-clear behavior (an "X" that nulls the slot) — there's nothing to reorder/lose the position of, so undo adds little value there; only list-shaped data (rows, freeform photo arrays) benefits from it.

Only one undo toast is shown at a time. Removing a second item while an earlier removal's toast is still showing replaces it — the earlier removal becomes final immediately (its undo window ends early) and the toast now reflects the newest removal. This matches the common single-snackbar pattern and avoids stacking/queueing UI.

## Review & Finalize

Clicking the bottom bar's **Finalize & Generate PDF**:
- If every real section is filled (per the completion heuristic) → submits immediately, exactly like today's finalize flow (save-then-finalize-then-download), with no extra step. The common, fully-filled case is not slowed down.
- If any section is still unfilled → does **not** submit. Instead, navigates the content area to the virtual "Review & Finalize" sidebar entry and stops.

The **Review & Finalize** panel (shown when that sidebar entry is active) lists every section with its filled/unfilled status (same data the sidebar already computes) and has its own **"Finalize Anyway"** button, which unconditionally runs the actual save-then-finalize-then-download flow regardless of completion state. This button exists only in this panel, not in the persistent bottom bar — the bottom bar's Finalize always re-runs the completeness check first.

## Drag-and-drop photo upload

`ImageUploadCard` (`src/components/shared/PdiImageUpload.jsx`) gains `onDragOver`/`onDrop` handlers on its image container: `onDragOver` calls `preventDefault()` and applies a highlight style; `onDrop` calls `preventDefault()`, reads `e.dataTransfer.files[0]`, and calls the existing `onSelect(file, null)` callback — the same one click-to-browse already uses (`inputEl` is only ever used to reset an `<input>`'s value after a click-driven pick, so `null` is safe for a drop, which has no such input to reset). No change to the crop/compress pipeline downstream of `onSelect`.

## File structure

- `src/components/admin/GenericPdiGeneratorForm.jsx` — trimmed down to: definition/report fetching, flattened-section-list construction, form state, autosave orchestration, undo-toast state, exit/close, and top-level layout (top bar + sidebar + content area + bottom bar composition). No longer holds the per-section-type render functions.
- `src/components/admin/GenericPdiSections.jsx` (new) — the existing per-type render functions (`HeaderSection`, `RepeatableTableSection`, `FixedTableSection`, `FreeformPhotoSection`, `FixedSlotPhotoSection`, `ImageSection`, `SignatureSection`, `TextSection`), the `renderSection` dispatcher, and the pure helpers `buildDefaultFormData`/`makeEmptyRow` — moved verbatim (styling updates land here, not logic changes), imported by the main file. Splitting this out keeps the main file focused on orchestration/state and this file focused on "how does section type X render," matching the file's existing internal boundary, just promoted to a module boundary now that the main file is gaining autosave/undo/review logic on top.
- `src/components/admin/GenericPdiSidebar.jsx` (new) — presentational only: takes the flattened section list, per-section completion, active key, and an `onSelect` callback; renders the progress bar and section rows plus the Review & Finalize row.
- `src/components/shared/PdiImageUpload.jsx` — `ImageUploadCard` gains the drag-and-drop handlers described above; `CropModal` unchanged.

## Testing

Existing Jest/RTL frontend test coverage for this component (if any) gets updated for the new structure; this is primarily a UI/interaction change best verified live (matching this project's established pattern of a personal live-verification pass via the gstack skill for the riskiest UI pieces) — author or reuse a published template covering all 6 section types, fill it out through the new sidebar flow, confirm autosave fires (network tab or a deliberate reload mid-fill to confirm data survived), confirm undo restores a removed row/photo, confirm Finalize redirects to Review when incomplete and submits directly when complete, confirm drag-and-drop on a photo slot, and confirm the resulting PDF is unchanged from before this redesign (this phase does not touch PDF generation).
