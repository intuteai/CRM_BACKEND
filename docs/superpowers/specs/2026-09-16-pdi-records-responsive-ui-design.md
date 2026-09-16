# PDI Records Table — Responsive & Visual Refresh Design

## Goal

Make the PDI Records table (`CRM/src/components/shared/PdiReportsTable.jsx`) usable on phone/tablet widths, give it a visual polish pass, and add a real server-side status filter — without changing any other existing behavior (data, actions, permissions, pagination, or the existing page-local search/sort).

## Background

The table currently renders as a single wide `<table>` inside an `overflow-x-auto` wrapper at every screen width. On a phone this means horizontal scrolling through 8 columns (Sr. No, PDI No., Customer, Status, Prepared By, Approved By, Inspection Date, Actions) — usable, but cramped and inconsistent with how the rest of the product (including the PDI mobile app) presents lists.

This follows two bug-fix rounds already shipped against this same component this week (raw-JSON-error-toast fix; ordering/Prepared-By/Approved-By fixes). This pass is presentation plus one small, well-scoped backend addition (status filter) — no other backend changes.

Design was worked out through the visual brainstorming companion across several rounds: three mobile-layout options were mocked and **Stacked Cards** was chosen; a desktop before/after comparison was mocked and the refresh was approved; a broader "everything we could add" pass (stat-count chips, a Template filter, per-row template badges, status-accent row borders) was shown, and only the **status-accent border** was kept — the rest were explicitly declined to keep this focused.

## Approach

CSS-only breakpoint switch inside the existing component, no new component, no JS viewport detection:

- **Below 768px (Tailwind `md`):** render the new stacked-card layout, one card per report.
- **768px and up:** render the existing `<table>` markup, refreshed.
- Both layouts read from the same `sortedPdiReports` array and call the same handlers (`handleResume`, `handleViewDownload`, `handleDuplicate`, `handleDelete`) — implemented as two render branches using Tailwind's `hidden md:block` / `block md:hidden` pattern, so there's no duplicate data-fetching or state, only duplicate markup.
- No change to `canManage`, pagination (`handleNextPage`/`handlePrevPage`/`handleRefresh`), the existing page-local search (`filteredPdiReports`) or sort (`sortedPdiReports`, including its existing sort-resets-on-page-change behavior), or the "search/sort only applies to this page" note — that note renders above both layouts unchanged.

## Visual refresh (applies at every width)

- **Status pill:** replace the current plain colored text with a filled, rounded pill badge — Completed = green, In Progress = amber, Failed = red, Pending = gray. Same four states as today.
- **Status-accent border:** a 4px colored left edge on each row (table) / card, using the same per-status color as the pill, so the status reads at a glance even before looking at the pill text.
- Tightened, more consistent spacing across rows/cards; a hover state on desktop rows.
- Search bar and Refresh button get the same visual polish (consistent with the pill/spacing treatment) — no behavior change to either.

## Mobile card layout (below 768px)

One card per report:

1. **Top row:** PDI No. (bold) on the left, status pill on the right.
2. **Subtitle line:** `{Customer} — {Inspection Date}` (existing `formatDate` helper; same `—`/`N/A` fallbacks as today's table).
3. **Two-column mini-grid:** Prepared By / Approved By (same `N/A` fallback as today).
4. **Action icons row:** same icons, same order, same `canManage`-gated visibility as the desktop Actions column.

Sr. No is not shown on the card — PDI No. is the primary identifier there (validated directly against the approved mockup).

## Desktop table (768px and up)

Same 8 columns, same sort-by-column-header behavior, same cell content — status pill, status-accent border, and spacing polish as described above.

## New: server-side Status filter

- A `<select>` next to the search box: All statuses / Pending / In Progress / Completed / Failed.
- **Backend:** `PdiReports.listReports({ limit, cursor, status })` already accepts and filters by `status` server-side (see `models/operations/pdiReports.js`) — this was built for the existing (unused by the frontend) `status` query param on `GET /api/pdi/reports`. No backend change needed; the frontend just needs to pass it.
- **Frontend:** changing the dropdown re-fetches from the server with the new `status` value, resets `cursorHistory`/`currentCursor` to the first page (same reset pattern already used by `handleRefresh`), and resets `sortConfig` to `null` (same reasoning as the existing page-change sort reset — a new filtered result set is a new "page" in the same sense).
- This filter is explicitly **not** page-local like search/sort — it changes what the server returns, so it's accurate across the whole dataset.

## Explicitly declined (discussed, not building)

- Stat-count chips (Total/Completed/In Progress/Pending counts, clickable to filter)
- A second Template filter (General/AutoNXT/custom)
- A per-row template badge

These were mocked and shown; the user chose to keep this pass focused on the status-accent border and status filter rather than add them.

## Out of scope

- No changes to `PdiReportsTable.jsx`'s data fetching shape beyond adding the `status` param, no changes to other handlers' behavior.
- No numbered/offset pagination (page 1, 2, 3...) — the backend uses keyset/cursor pagination for performance; jumping to an arbitrary page isn't feasible without a much larger change, and wasn't requested.
- No changes to PDI Generator or PDI Templates pages — confirmed scoped to the Records table only.
- No new statuses, columns, or actions beyond the status filter itself.

## Testing

Visual verification via gstack browse at both a desktop viewport (~1280px) and a phone viewport (~375px), against live data, checking:
- Card layout renders correctly with real Prepared By/Approved By/status/date values, including the `N/A`/`—` fallback cases, with the correct status-accent color.
- All four actions still work identically from the card layout (same handlers, same confirmation prompts, same `canManage` gating).
- Desktop table still sorts/searches/paginates exactly as before, with the new pill status and accent border.
- Status filter dropdown correctly re-fetches server-side, resets to page 1, and the "N of TOTAL" count reflects the filtered total, not the unfiltered one.
- No regression to the existing "search/sort only applies to this page" note or the empty-state message (including a new "no reports match this filter" case when the status filter excludes everything).
