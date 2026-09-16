# PDI Records Responsive & Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PDI Records table usable and good-looking on phone widths, refresh its desktop visuals (status pills, accent borders), and add a real server-side status filter.

**Architecture:** Everything lives in one file, `CRM/src/components/shared/PdiReportsTable.jsx`. A shared `getStatusStyle()` helper drives both the status pill and the accent border classes, used by both a refreshed desktop `<table>` (rendered `md:` and up) and a new stacked-card list (rendered below `md`), via Tailwind's `hidden md:block` / `md:hidden` — no new component, no JS viewport detection. The status filter is a `<select>` that threads a `status` value into the already-existing `fetchPdiReports` call; the backend already accepts and filters by it end-to-end (verified live against production — `GET /api/pdi/reports?status=Completed` already returns the correct filtered `data` and `total`), so **no backend changes are needed anywhere in this plan.**

**Tech Stack:** React (hooks only, no new deps), Tailwind CSS utility classes, existing `fetch`-based API client pattern already used throughout this file.

**Spec:** `docs/superpowers/specs/2026-09-16-pdi-records-responsive-ui-design.md`

---

### Task 1: Server-side status filter — state, fetch, and UI

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

- [ ] **Step 1: Add `statusFilter` state**

In the state block near the other `useState` calls (right after the `sortConfig` declaration, before the `cursor` comment block), add:

```js
  // '' = All statuses. Unlike search/sort (page-local), this is a real
  // server-side filter -- GET /api/pdi/reports?status=X already filters and
  // counts correctly on the backend (verified against production), so
  // changing this always re-fetches rather than filtering client-side.
  const [statusFilter, setStatusFilter] = useState('');
```

- [ ] **Step 2: Thread `statusToUse` through `fetchPdiReports`**

Replace the current `fetchPdiReports` implementation:

```js
  const fetchPdiReports = useCallback(
    async (cursorToUse) => {
      if (isFetching.current) return false;
      isFetching.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('token');
        const url = cursorToUse
          ? `${BASE_URL}/api/pdi/reports?limit=${limit}&cursor=${encodeURIComponent(cursorToUse)}`
          : `${BASE_URL}/api/pdi/reports?limit=${limit}`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
```

with:

```js
  const fetchPdiReports = useCallback(
    async (cursorToUse, statusToUse) => {
      if (isFetching.current) return false;
      isFetching.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('token');
        const params = new URLSearchParams({ limit: String(limit) });
        if (cursorToUse) params.set('cursor', cursorToUse);
        if (statusToUse) params.set('status', statusToUse);
        const url = `${BASE_URL}/api/pdi/reports?${params.toString()}`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
```

The rest of `fetchPdiReports` (from `if (!response.ok) {` through the closing `}, [limit, notifyError]);`) is unchanged.

- [ ] **Step 3: Pass `statusFilter` through every existing caller of `fetchPdiReports`**

In the mount `useEffect`, change:
```js
      fetchPdiReports(null);
```
to:
```js
      fetchPdiReports(null, '');
```
(the initial mount always starts with no filter, since `statusFilter` state is `''` at that point too).

In `handlePrevPage`, change:
```js
  const handlePrevPage = useCallback(async () => {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1];
    const succeeded = await fetchPdiReports(prevCursor);
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => h.slice(0, -1));
    setCurrentCursor(prevCursor);
    setSortConfig(null); // a page-local sort has nothing left to apply to on the new page
  }, [cursorHistory, fetchPdiReports]);
```
to:
```js
  const handlePrevPage = useCallback(async () => {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1];
    const succeeded = await fetchPdiReports(prevCursor, statusFilter);
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => h.slice(0, -1));
    setCurrentCursor(prevCursor);
    setSortConfig(null); // a page-local sort has nothing left to apply to on the new page
  }, [cursorHistory, fetchPdiReports, statusFilter]);
```

In `handleNextPage`, change:
```js
  const handleNextPage = useCallback(async () => {
    if (!cursor || isLoading) return;
    const targetCursor = cursor;
    const previousCursor = currentCursor;
    const succeeded = await fetchPdiReports(targetCursor);
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => [...h, previousCursor]);
    setCurrentCursor(targetCursor);
    setSortConfig(null); // a page-local sort has nothing left to apply to on the new page
  }, [cursor, isLoading, currentCursor, fetchPdiReports]);
```
to:
```js
  const handleNextPage = useCallback(async () => {
    if (!cursor || isLoading) return;
    const targetCursor = cursor;
    const previousCursor = currentCursor;
    const succeeded = await fetchPdiReports(targetCursor, statusFilter);
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => [...h, previousCursor]);
    setCurrentCursor(targetCursor);
    setSortConfig(null); // a page-local sort has nothing left to apply to on the new page
  }, [cursor, isLoading, currentCursor, fetchPdiReports, statusFilter]);
```

In `handleRefresh`, change:
```js
  const handleRefresh = useCallback(() => {
    setCursorHistory([]);
    setCurrentCursor(null);
    setSortConfig(null);
    fetchPdiReports(null);
  }, [fetchPdiReports]);
```
to:
```js
  const handleRefresh = useCallback(() => {
    setCursorHistory([]);
    setCurrentCursor(null);
    setSortConfig(null);
    fetchPdiReports(null, statusFilter);
  }, [fetchPdiReports, statusFilter]);
```

- [ ] **Step 4: Add `handleStatusFilterChange`**

Directly below the `handleRefresh` definition from Step 3, add:

```js
  const handleStatusFilterChange = useCallback(
    (e) => {
      const nextStatus = e.target.value;
      setStatusFilter(nextStatus);
      setCursorHistory([]);
      setCurrentCursor(null);
      setSortConfig(null); // a new filtered result set is a new "page" in the same sense as paging
      fetchPdiReports(null, nextStatus);
    },
    [fetchPdiReports]
  );
```

- [ ] **Step 5: Add the `<select>` to the toolbar**

In the JSX, the toolbar is:
```jsx
        <div className="flex mb-8 gap-6 flex-wrap">
          <div className="relative flex-grow">
            <label htmlFor="search-pdi" className="sr-only">Search PDI Reports</label>
            <input
              id="search-pdi"
              ref={searchInputRef}
              type="text"
              placeholder="Search by PDI No., Customer, Status, Prepared By, or Approved By..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full p-4 pl-12 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300 text-lg bg-white shadow-md transition-all duration-300"
            />
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" />
          </div>
          <button
            onClick={handleRefresh}
            className="p-4 bg-amber-400 text-gray-900 rounded-lg hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-300 transition-all duration-300 shadow-md text-lg"
            disabled={isLoading}
            aria-label="Refresh PDI reports"
          >
            {isLoading && pdiReports.length > 0 ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
```

Insert a new `<select>` between the search `<div>` and the Refresh `<button>`:
```jsx
        <div className="flex mb-8 gap-6 flex-wrap">
          <div className="relative flex-grow">
            <label htmlFor="search-pdi" className="sr-only">Search PDI Reports</label>
            <input
              id="search-pdi"
              ref={searchInputRef}
              type="text"
              placeholder="Search by PDI No., Customer, Status, Prepared By, or Approved By..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full p-4 pl-12 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300 text-lg bg-white shadow-md transition-all duration-300"
            />
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400" />
          </div>
          <label htmlFor="status-filter-pdi" className="sr-only">Filter by status</label>
          <select
            id="status-filter-pdi"
            value={statusFilter}
            onChange={handleStatusFilterChange}
            disabled={isLoading}
            className="p-4 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-300 text-lg bg-white shadow-md transition-all duration-300"
          >
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="In Progress">In Progress</option>
            <option value="Completed">Completed</option>
            <option value="Failed">Failed</option>
          </select>
          <button
            onClick={handleRefresh}
            className="p-4 bg-amber-400 text-gray-900 rounded-lg hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-300 transition-all duration-300 shadow-md text-lg"
            disabled={isLoading}
            aria-label="Refresh PDI reports"
          >
            {isLoading && pdiReports.length > 0 ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
```

- [ ] **Step 6: Handle the filtered-empty case in the empty-state message**

Change:
```jsx
          {!isLoading && sortedPdiReports.length === 0 && (
            <div className="text-center py-12 text-gray-500 flex flex-col items-center" role="status">
              <Search className="mb-4 text-gray-400" size={48} />
              <p className="text-lg">{pdiReports.length === 0 ? 'No PDI reports yet.' : 'No PDI reports found matching your search.'}</p>
            </div>
          )}
```
to:
```jsx
          {!isLoading && sortedPdiReports.length === 0 && (
            <div className="text-center py-12 text-gray-500 flex flex-col items-center" role="status">
              <Search className="mb-4 text-gray-400" size={48} />
              <p className="text-lg">
                {pdiReports.length > 0
                  ? 'No PDI reports found matching your search.'
                  : statusFilter
                    ? `No ${statusFilter} PDI reports found.`
                    : 'No PDI reports yet.'}
              </p>
            </div>
          )}
```

- [ ] **Step 7: Lint and manually sanity-check**

Run: `cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx`
Expected: no output (clean).

- [ ] **Step 8: Commit**

```bash
cd CRM
git add src/components/shared/PdiReportsTable.jsx
git commit -m "$(cat <<'EOF'
feat: add server-side status filter to PDI Records

A <select> next to search, backed by the backend's existing status query
param on GET /api/pdi/reports (already filters and counts correctly --
verified live, no backend change needed). Changing it resets pagination
and the page-local sort, then re-fetches, same pattern already used by
Refresh.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Status pill + accent border on the desktop table

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

- [ ] **Step 1: Add the shared status-style helper**

Directly below the `formatDate` function (before the component definition), add:

```js
// Single source of truth for status -> color treatment, shared by the pill
// badge and the accent border, in both the desktop table and the mobile
// card list added in Task 3. Same four statuses the table has always had.
const STATUS_STYLES = {
  Completed: { pill: 'bg-green-100 text-green-700', border: 'border-l-green-500' },
  'In Progress': { pill: 'bg-yellow-100 text-yellow-700', border: 'border-l-yellow-500' },
  Failed: { pill: 'bg-red-100 text-red-700', border: 'border-l-red-500' },
  Pending: { pill: 'bg-gray-100 text-gray-600', border: 'border-l-gray-300' },
};
const DEFAULT_STATUS_STYLE = { pill: 'bg-gray-100 text-gray-600', border: 'border-l-gray-300' };

function getStatusStyle(status) {
  return STATUS_STYLES[status] || DEFAULT_STATUS_STYLE;
}
```

- [ ] **Step 2: Apply the accent border and pill to each table row**

Change the row and status cell from:
```jsx
              {sortedPdiReports.map((report) => (
                <tr key={report.report_id} className="border-t hover:bg-amber-50 transition-all duration-200" role="row">
                  <td className="py-4 px-3 text-gray-600 text-base">{report.sr_no}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.pdi_no || '—'}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.customer_name || '—'}</td>
                  <td
                    className={`py-4 px-3 text-base ${
                      report.status === 'Completed' ? 'text-green-600' :
                      report.status === 'In Progress' ? 'text-yellow-600' :
                      report.status === 'Failed' ? 'text-red-600' : 'text-gray-600'
                    }`}
                  >
                    {report.status}
                  </td>
```
to:
```jsx
              {sortedPdiReports.map((report) => (
                <tr key={report.report_id} className={`border-t border-l-4 ${getStatusStyle(report.status).border} hover:bg-amber-50 transition-all duration-200`} role="row">
                  <td className="py-4 px-3 text-gray-600 text-base">{report.sr_no}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.pdi_no || '—'}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.customer_name || '—'}</td>
                  <td className="py-4 px-3 text-base">
                    <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${getStatusStyle(report.status).pill}`}>
                      {report.status}
                    </span>
                  </td>
```

The rest of the row (`Prepared By` through `Actions`) is unchanged.

- [ ] **Step 3: Lint**

Run: `cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
cd CRM
git add src/components/shared/PdiReportsTable.jsx
git commit -m "$(cat <<'EOF'
feat: refresh PDI Records desktop table — status pill + accent border

Replaces plain colored status text with a filled pill badge, and adds a
4px status-colored left border per row, both driven by the new shared
getStatusStyle() helper (also used by the mobile card layout in the next
commit). Same four statuses, no behavior change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Mobile stacked-card layout

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

- [ ] **Step 1: Extract the shared action buttons into a small local component**

The table's Actions cell and the new card's action row need identical markup (same 4 buttons, same conditions, same handlers). Add this component directly above the default-exported `PdiReportsTable` function (i.e., right after the `getStatusStyle` function from Task 2, before `export default function PdiReportsTable(...)`):

```jsx
// Shared by both the desktop table's Actions cell and the mobile card's
// action row (Task 3) -- identical buttons, conditions, and handlers in
// both places, so this is the one spot that needs editing if that ever
// changes.
function ReportActions({ report, canManage, duplicatingIds, onResume, onViewDownload, onDuplicate, onDelete }) {
  return (
    <div className="flex items-center gap-1">
      {canManage && (
        <button onClick={() => onResume(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="Resume in Generator" aria-label={`Resume PDI report ${report.pdi_no || report.report_id}`}>
          <Pencil size={18} />
        </button>
      )}
      <button onClick={() => onViewDownload(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="View / Download PDF" aria-label={`View PDI report ${report.pdi_no || report.report_id}`}>
        <Eye size={18} />
      </button>
      {canManage && (
        <button
          onClick={() => onDuplicate(report)}
          disabled={duplicatingIds.has(report.report_id)}
          className="p-2 hover:bg-amber-100 rounded-full text-amber-700 disabled:opacity-40 disabled:hover:bg-transparent"
          title="Duplicate as New PDI"
          aria-label={`Duplicate PDI report ${report.pdi_no || report.report_id}`}
        >
          <Copy size={18} />
        </button>
      )}
      {canManage && (
        <button onClick={() => onDelete(report)} className="p-2 hover:bg-red-50 rounded-full text-red-500" title="Delete" aria-label={`Delete PDI report ${report.pdi_no || report.report_id}`}>
          <Trash2 size={18} />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Use `ReportActions` in the desktop table's Actions cell**

Change:
```jsx
                  <td className="py-4 px-3 text-gray-600 text-base">
                    <div className="flex items-center gap-1">
                      {canManage && (
                        <button onClick={() => handleResume(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="Resume in Generator" aria-label={`Resume PDI report ${report.pdi_no || report.report_id}`}>
                          <Pencil size={18} />
                        </button>
                      )}
                      <button onClick={() => handleViewDownload(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="View / Download PDF" aria-label={`View PDI report ${report.pdi_no || report.report_id}`}>
                        <Eye size={18} />
                      </button>
                      {canManage && (
                        <button
                          onClick={() => handleDuplicate(report)}
                          disabled={duplicatingIds.has(report.report_id)}
                          className="p-2 hover:bg-amber-100 rounded-full text-amber-700 disabled:opacity-40 disabled:hover:bg-transparent"
                          title="Duplicate as New PDI"
                          aria-label={`Duplicate PDI report ${report.pdi_no || report.report_id}`}
                        >
                          <Copy size={18} />
                        </button>
                      )}
                      {canManage && (
                        <button onClick={() => handleDelete(report)} className="p-2 hover:bg-red-50 rounded-full text-red-500" title="Delete" aria-label={`Delete PDI report ${report.pdi_no || report.report_id}`}>
                          <Trash2 size={18} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```
to:
```jsx
                  <td className="py-4 px-3 text-gray-600 text-base">
                    <ReportActions
                      report={report}
                      canManage={canManage}
                      duplicatingIds={duplicatingIds}
                      onResume={handleResume}
                      onViewDownload={handleViewDownload}
                      onDuplicate={handleDuplicate}
                      onDelete={handleDelete}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
```

- [ ] **Step 3: Wrap the table for the `md:` breakpoint and add the mobile card list**

The current structure (after Task 2) is:
```jsx
        <div className="bg-white rounded-2xl shadow-lg overflow-x-auto">
          <table className="w-full text-left border-collapse" role="grid" aria-label="PDI Reports table" ref={tableRef} tabIndex={0}>
            ...
          </table>

          {totalItems > 0 && (
            <div className="flex justify-between items-center p-4 bg-gray-50">
              ...
            </div>
          )}

          {!isLoading && sortedPdiReports.length === 0 && (
            ...
          )}
        </div>
```

Change the outer wrapper and add the card list between the table and the pagination footer:
```jsx
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse" role="grid" aria-label="PDI Reports table" ref={tableRef} tabIndex={0}>
              ...
            </table>
          </div>

          <div className="md:hidden divide-y divide-gray-100">
            {sortedPdiReports.map((report) => (
              <div key={report.report_id} className={`p-4 border-l-4 ${getStatusStyle(report.status).border}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-gray-800 text-base">{report.pdi_no || '—'}</span>
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${getStatusStyle(report.status).pill}`}>
                    {report.status}
                  </span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {report.customer_name || '—'} — {report.inspection_date ? formatDate(report.inspection_date) : 'N/A'}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2 text-xs text-gray-500">
                  <div><span className="font-semibold text-gray-600">Prepared:</span> {report.prepared_by || 'N/A'}</div>
                  <div><span className="font-semibold text-gray-600">Approved:</span> {report.approved_by || 'N/A'}</div>
                </div>
                <div className="mt-3">
                  <ReportActions
                    report={report}
                    canManage={canManage}
                    duplicatingIds={duplicatingIds}
                    onResume={handleResume}
                    onViewDownload={handleViewDownload}
                    onDuplicate={handleDuplicate}
                    onDelete={handleDelete}
                  />
                </div>
              </div>
            ))}
          </div>

          {totalItems > 0 && (
            <div className="flex justify-between items-center p-4 bg-gray-50">
              ...
            </div>
          )}

          {!isLoading && sortedPdiReports.length === 0 && (
            ...
          )}
        </div>
```
(The pagination footer and empty-state blocks themselves are untouched from Task 1/today's code — only the wrapper `<div>` around the table changed, and the new card `<div>` was inserted between the table wrapper and the pagination footer. `overflow-x-auto` moved from the outer wrapper onto the new table-only wrapper, since the card list never needs horizontal scroll; the outer wrapper uses `overflow-hidden` instead so the `rounded-2xl` corners still clip correctly.)

- [ ] **Step 4: Lint**

Run: `cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
cd CRM
git add src/components/shared/PdiReportsTable.jsx
git commit -m "$(cat <<'EOF'
feat: add stacked-card layout for PDI Records below md breakpoint

Below 768px, renders one card per report (PDI No. + status pill, customer
+ date, Prepared/Approved mini-grid, actions) instead of the table, via a
plain hidden md:block / md:hidden split -- same data, same handlers, same
canManage gating, no JS viewport detection. Extracted the action buttons
into a shared ReportActions component since the table and card layouts
need identical markup.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Live verification (controller-personal, not a subagent)

Do this yourself in the current session — it needs live judgment about what's actually on screen, and involves live production data cleanup.

- [ ] **Step 1: Read the full file once more end-to-end** after Tasks 1-3 to confirm the merged result is coherent (no leftover duplicate blocks, no stale references to removed inline JSX).

- [ ] **Step 2: Live desktop check (~1280px viewport)** via gstack browse against `https://intute.biz/pdi` (or wherever PdiReportsTable is mounted):
  - Status pills render with the correct 4 colors; accent border color matches the pill for the same row.
  - Sort-by-column-header still works, and still resets when Next/Prev/Refresh/the new status filter is used (unchanged behavior from before this plan).
  - Status filter: pick "Completed" — confirm the result set actually narrows (compare against total before filtering), the "Showing N of TOTAL" count reflects the filtered total, and pagination still works within the filtered view. Pick "All statuses" again and confirm it returns to the unfiltered view.
  - Trigger the filtered-empty case (a status with zero matching reports, or a `ZZTEST`-prefixed search on top of a filter) and confirm the new "No {status} PDI reports found." message appears correctly.

- [ ] **Step 3: Live mobile check (~375px viewport)** via gstack browse (`$B viewport 375x812`):
  - Cards render for General, AutoNXT, and any custom-template report present in the data, each showing correct PDI No./status pill/customer/date/Prepared/Approved, with `N/A`/`—` fallbacks matching what the desktop table would show for the same report.
  - All four actions work from the card (Resume navigates correctly with the report's own `template_id`; View/Download opens the PDF; Duplicate is disabled while in flight and navigates to the new report on success; Delete asks for confirmation and removes the card). Confirm `canManage`-gated buttons are hidden for a non-admin/production role if a second test account is available; if not, confirm the gating logic (`canManage &&`) is unchanged from before this plan by inspection.
  - No horizontal scrollbar appears on the card list at this width.

- [ ] **Step 4: Fix anything found**, re-run the relevant lint/visual check, and commit the fix with its own message (same repo/commit conventions as Tasks 1-3).

- [ ] **Step 5: Clean up.** This backend hits the same production RDS database as intute.biz — no separate staging DB. Delete any `ZZTEST`-style throwaway report created for verification, and confirm the total report count matches what it was before this task started.
