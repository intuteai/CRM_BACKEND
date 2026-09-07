# PDI Web Form Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the CRM web frontend (the PDI Generator form and its two dashboard pages) onto the already-live `/api/pdi/reports/*` backend, then retire the now-unused legacy `/api/pdi` generate/CRUD system, per `docs/superpowers/specs/2026-09-04-pdi-web-form-migration-design.md`.

**Architecture:** Two repos change. In `CRM_BACKEND`: the list endpoint gains two lightweight fields, then the legacy model/controller-exports/routes are deleted outright (verified to have zero other consumers). In `CRM`: `PdiPage.jsx` and `ProductionPDIPage.jsx` — currently near-identical duplicates — collapse into one new shared `PdiReportsTable.jsx`, and `PDIGeneratorForm.jsx` gets rewired for create-on-open, explicit save, resume-by-link, and finalize, replacing its current one-shot "generate and forget" flow.

**Tech Stack:** Express/PostgreSQL (backend, Jest + Supertest — TDD as usual), React/Vite with `react-router-dom` v6 and `axios`/`fetch` (frontend — this repo has **no test framework** (`grep` confirms no vitest/jest/testing-library in `package.json`, no `*.test.jsx` anywhere), so frontend tasks substitute `npm run build` + `npm run lint` as the automated correctness gate, plus a careful diff self-review, in place of the write-test/watch-fail/watch-pass cycle used for backend tasks).

---

## File Structure

| File | Repo | Responsibility |
|---|---|---|
| `models/operations/pdiReports.js` | CRM_BACKEND | **Modify.** `listReports` gains `pdi_no` and form-sourced `customer_name`. |
| `tests/pdiReports.test.js` | CRM_BACKEND | **Modify.** Extend the list test to assert the two new fields; add a small legacy-retirement regression check. |
| `models/operations/pdi.js` | CRM_BACKEND | **Delete.** The legacy model. |
| `controllers/operations/pdi.controller.js` | CRM_BACKEND | **Modify.** Remove `generate`/`create`/`getAll`/`getOne`/`update`/`delete`; keep only `getTemplates`. |
| `routes/operations/pdi.js` | CRM_BACKEND | **Modify.** Remove all routes except `GET /templates`. |
| `CRM/src/components/shared/PdiReportsTable.jsx` | CRM | **Create.** The new unified dashboard component (new `shared/` directory — first component of its kind in this codebase, since it's the first component genuinely used by two different role-scoped pages). |
| `CRM/src/components/admin/PdiPage.jsx` | CRM | **Rewrite** as a thin wrapper around `PdiReportsTable`. |
| `CRM/src/components/production/ProductionPDIPage.jsx` | CRM | **Rewrite** as a thin wrapper around `PdiReportsTable`. |
| `CRM/src/components/admin/PDIGeneratorForm.jsx` | CRM | **Modify** across three tasks: create/save/cancel wiring, finalize wiring, resume-via-query-param wiring. |

**Existing files this plan does NOT touch:** `models/operations/pdi_generator.js`, `services/googleDrive.js`, `controllers/operations/pdiReports.controller.js` (beyond what Task 1 requires — no changes needed there), `routes/operations/pdiReports.js`, `server.js`. `CRM/src/routeConfig.jsx` needs no changes — the routes already point at the same component names, which keep the same default export signatures.

**Explicitly out of scope:** the custom template-authoring system, the mobile app, any change to the PDI Generator's actual form fields/photo handling/PDF layout.

---

## Task 1: List endpoint gains `pdi_no` and form-sourced `customer_name`

**Files:**
- Modify: `models/operations/pdiReports.js`
- Modify: `tests/pdiReports.test.js`

The dashboard needs to show a PDI No. and Customer column without an N+1 fetch per row. `GET /api/pdi/reports` (list) currently returns a `customer_name` sourced only from a joined CRM `customer_id` link (almost always null, since the Generator flow is free-form) and no `pdi_no` at all. This task adds both, extracted cheaply from the JSONB `data` column via Postgres `->>'key'`, without pulling the whole `data`/`photos` blob into the list response.

- [ ] **Step 1: Write the failing test**

Modify the existing `it('lists reports filtered by status', ...)` test in `tests/pdiReports.test.js` — add assertions after the existing ones:

```js
    expect(list.body.data.some((r) => r.report_id === created.body.report_id)).toBe(true);
    expect(list.body.data.every((r) => r.status === 'Failed')).toBe(true);
    const listedReport = list.body.data.find((r) => r.report_id === created.body.report_id);
    expect(listedReport.pdi_no).toBe('PDI-TEST-LIST-1');
    expect(listedReport.customer_name).toBe('R.K. Traders');
```

(The full test, for reference — only the 3 new lines at the end are new:)

```js
  it('lists reports filtered by status', async () => {
    const created = await request(app)
      .post('/api/pdi/reports')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ data: { customer_name: 'R.K. Traders', pdi_no: 'PDI-TEST-LIST-1' } });
    createdReportIds.push(created.body.report_id);
    await request(app)
      .patch(`/api/pdi/reports/${created.body.report_id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Failed' });

    const list = await request(app)
      .get('/api/pdi/reports?status=Failed&limit=50')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(list.statusCode).toBe(200);
    expect(list.body.data.some((r) => r.report_id === created.body.report_id)).toBe(true);
    expect(list.body.data.every((r) => r.status === 'Failed')).toBe(true);
    const listedReport = list.body.data.find((r) => r.report_id === created.body.report_id);
    expect(listedReport.pdi_no).toBe('PDI-TEST-LIST-1');
    expect(listedReport.customer_name).toBe('R.K. Traders');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — `listedReport.pdi_no` is `undefined` (the field doesn't exist in the response yet).

- [ ] **Step 3: Add the two fields to `listReports`**

In `models/operations/pdiReports.js`, modify the `listReports` query. Replace the current query and row-mapping with:

```js
    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        pdi.data->>'pdi_no' AS pdi_no,
        pdi.data->>'customer_name' AS form_customer_name,
        u.name AS linked_customer_name,
        COALESCE(pdi.inspection_date, 'infinity'::timestamp)::text AS sort_key
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE (
        $1::text IS NULL
        OR COALESCE(pdi.inspection_date, 'infinity'::timestamp) < $1::timestamp
        OR (COALESCE(pdi.inspection_date, 'infinity'::timestamp) = $1::timestamp AND pdi.report_id < $2)
      )
      AND ($4::text IS NULL OR pdi.status = $4)
      ORDER BY COALESCE(pdi.inspection_date, 'infinity'::timestamp) DESC, pdi.report_id DESC
      LIMIT $3
    `;
```

(Only the `SELECT` clause changed — added `pdi.data->>'pdi_no' AS pdi_no`, renamed `u.name AS customer_name` to `u.name AS linked_customer_name`, added `pdi.data->>'customer_name' AS form_customer_name`. The `WHERE`/`ORDER BY`/`LIMIT` clauses, and the count query below it, are unchanged.)

Then update the row-mapping in the same method's return statement — replace:

```js
      data: rows.map((row) => ({
        report_id: row.report_id,
        sr_no: row.sr_no,
        status: row.status,
        template_id: row.template_id,
        customer_id: row.customer_id,
        order_id: row.order_id,
        customer_name: row.customer_name,
        inspected_by: row.inspected_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
```

with:

```js
      data: rows.map((row) => ({
        report_id: row.report_id,
        sr_no: row.sr_no,
        status: row.status,
        template_id: row.template_id,
        customer_id: row.customer_id,
        order_id: row.order_id,
        pdi_no: row.pdi_no || null,
        // Prefer the name typed on the report itself (the common, free-form case)
        // over a linked CRM customer record (rare in this flow, but still honored
        // if one's actually attached).
        customer_name: row.form_customer_name || row.linked_customer_name || null,
        inspected_by: row.inspected_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add models/operations/pdiReports.js tests/pdiReports.test.js
git commit -m "feat: surface pdi_no and form-sourced customer_name on the reports list endpoint"
```

---

## Task 2: Shared dashboard component — `PdiReportsTable.jsx`

**Files:**
- Create: `CRM/src/components/shared/PdiReportsTable.jsx`

This is the new unified dashboard, replacing the near-duplicate logic in `PdiPage.jsx` and `ProductionPDIPage.jsx`. It is NOT wired into any route yet — Tasks 3 and 4 do that. Work from `c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM`.

While rewriting the fetch/pagination logic (needed anyway, since the endpoint and cursor shape are changing), this task also fixes a real bug present in both existing files: their `handleNextPage`/`handlePrevPage` update `cursor` state but nothing ever re-fetches when that state changes, so Next/Prev are currently non-functional. The rewrite below fixes this by passing the cursor to fetch directly instead of routing it through a watched-but-unwatched piece of state.

- [ ] **Step 1: Create the file**

```jsx
// CRM/src/components/shared/PdiReportsTable.jsx
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate as importedFormatDate } from '../../utils/helpers';
import { ArrowDownUp, RefreshCw, Search, Eye, Pencil, Trash2 } from 'lucide-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { io } from 'socket.io-client';
import { useNotify } from '../../hooks/useNotify';
import ConnectionError from '../pages/ConnectionError.jsx';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// Roles that can open a report back up in the Generator to keep working on it.
// Everyone else (who can still see this dashboard) gets view/download only —
// matches who already has route access to /pdi-generator today.
const RESUME_ROLES = ['admin', 'production'];
const userRole = localStorage.getItem('role');
const canManage = RESUME_ROLES.includes(userRole);

const formatDate = (dateString) => {
  if (!dateString) return 'N/A';
  if (typeof importedFormatDate === 'function') return importedFormatDate(dateString);
  try {
    return new Date(dateString).toLocaleDateString();
  } catch (error) {
    console.error('Error formatting date:', error);
    return dateString;
  }
};

export default function PdiReportsTable({ socket: providedSocket, title = 'PDI Reports' }) {
  const [pdiReports, setPdiReports] = useState([]);
  const [totalItems, setTotalItems] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortConfig, setSortConfig] = useState({ key: 'report_id', direction: 'desc' });
  // `cursor` is the token for the NEXT page, handed back by the last response.
  // `cursorHistory` holds the cursor used to reach each PRIOR page (most recent
  // last), so Prev can pop back through them; `currentCursor` is whichever
  // cursor produced the page currently on screen (null = first page).
  const [cursor, setCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [currentCursor, setCurrentCursor] = useState(null);
  const [limit] = useState(10);
  const tableRef = useRef(null);
  const searchInputRef = useRef(null);
  const hasFetched = useRef(false);
  const isFetching = useRef(false);
  const navigate = useNavigate();
  const { notifySuccess, notifyError, notifyInfo } = useNotify();

  const socket = useMemo(
    () =>
      providedSocket ||
      io(BASE_URL, {
        withCredentials: true,
        transports: ['websocket'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      }),
    [providedSocket]
  );

  const fetchPdiReports = useCallback(
    async (cursorToUse) => {
      if (isFetching.current) return;
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

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || `Server responded with status: ${response.status}`);
        }

        const responseData = await response.json();
        if (!responseData.data || !Array.isArray(responseData.data)) {
          throw new Error('Invalid data format');
        }

        setPdiReports(responseData.data);
        setTotalItems(responseData.total || 0);
        setCursor(responseData.cursor || null);
      } catch (err) {
        console.error('Error fetching PDI reports:', err);
        const errorMessage = err.message || 'Network error. Please try again later.';
        setError(errorMessage);
        notifyError(errorMessage, { autoClose: 3000 });
      } finally {
        setIsLoading(false);
        isFetching.current = false;
      }
    },
    [limit, notifyError]
  );

  useEffect(() => {
    if (!hasFetched.current) {
      fetchPdiReports(null);
      hasFetched.current = true;
    }

    const handlePdiReportUpdate = ({ report_id, status }) => {
      setPdiReports((prev) => {
        if (!Array.isArray(prev)) return prev || [];

        if (status === 'Deleted') {
          notifyInfo(`PDI report #${report_id} deleted`, { autoClose: 2000 });
          return prev.filter((report) => report.report_id !== report_id);
        }

        const idx = prev.findIndex((report) => report.report_id === report_id);
        if (idx === -1 || prev[idx].status === status) return prev;

        const updated = [...prev];
        updated[idx] = { ...updated[idx], status };
        notifyInfo(`PDI report #${report_id} updated`, { autoClose: 2000 });
        return updated;
      });
    };

    socket.on('pdiReportUpdate', handlePdiReportUpdate);

    return () => {
      socket.off('pdiReportUpdate', handlePdiReportUpdate);
      if (!providedSocket) socket.disconnect();
    };
  }, [fetchPdiReports, socket, providedSocket, notifyInfo]);

  const handleSort = useCallback((key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      setSearchTerm('');
      searchInputRef.current?.focus();
    }
  }, []);

  const filteredPdiReports = useMemo(() => {
    if (!Array.isArray(pdiReports)) return [];
    return pdiReports.filter((item) => {
      if (!item) return false;
      const searchFields = [
        String(item.report_id || ''),
        String(item.sr_no || ''),
        String(item.pdi_no || ''),
        String(item.customer_name || ''),
        String(item.status || ''),
        String(item.inspected_by || ''),
      ];
      return searchFields.some((field) => field.toLowerCase().includes(searchTerm.toLowerCase()));
    });
  }, [pdiReports, searchTerm]);

  const sortedPdiReports = useMemo(() => {
    if (!filteredPdiReports.length) return [];
    return [...filteredPdiReports].sort((a, b) => {
      const valueA = a[sortConfig.key] ?? '';
      const valueB = b[sortConfig.key] ?? '';
      if (valueA < valueB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valueA > valueB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredPdiReports, sortConfig]);

  const handleResume = useCallback(
    (report) => {
      navigate(`/pdi-generator?report=${report.report_id}`);
    },
    [navigate]
  );

  const handleViewDownload = useCallback(
    async (report) => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}${report.report_link}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Failed to load PDF');
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => window.URL.revokeObjectURL(url), 60000);
      } catch (err) {
        console.error('View/download error:', err);
        notifyError('Could not open the PDI PDF.', { autoClose: 3000 });
      }
    },
    [notifyError]
  );

  const handleDelete = useCallback(
    async (report) => {
      const label = report.pdi_no || `#${report.report_id}`;
      if (!window.confirm(`Delete PDI report ${label}? This cannot be undone.`)) return;
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}/api/pdi/reports/${report.report_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Delete failed');
        setPdiReports((prev) => prev.filter((r) => r.report_id !== report.report_id));
        setTotalItems((prev) => Math.max(0, prev - 1));
        notifySuccess(`PDI report ${label} deleted.`, { autoClose: 2000 });
      } catch (err) {
        console.error('Delete error:', err);
        notifyError('Failed to delete PDI report.', { autoClose: 3000 });
      }
    },
    [notifySuccess, notifyError]
  );

  const handlePrevPage = useCallback(() => {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((h) => h.slice(0, -1));
    setCurrentCursor(prevCursor);
    fetchPdiReports(prevCursor);
  }, [cursorHistory, fetchPdiReports]);

  const handleNextPage = useCallback(() => {
    if (!cursor || isLoading) return;
    setCursorHistory((h) => [...h, currentCursor]);
    setCurrentCursor(cursor);
    fetchPdiReports(cursor);
  }, [cursor, isLoading, currentCursor, fetchPdiReports]);

  const handleRefresh = useCallback(() => {
    setCursorHistory([]);
    setCurrentCursor(null);
    fetchPdiReports(null);
  }, [fetchPdiReports]);

  if (isLoading && !pdiReports.length) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 to-gray-100 p-8 flex items-center justify-center" aria-live="polite">
        <div className="text-gray-600 text-xl animate-pulse">Loading PDI Reports...</div>
      </div>
    );
  }

  if (error && !pdiReports.length) return <ConnectionError onRetry={() => fetchPdiReports(null)} />;

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-gray-100 p-8">
      <h1 className="text-4xl font-bold text-gray-800 mb-10 text-center tracking-tight">{title}</h1>
      <div className="max-w-7xl mx-auto">
        <div className="flex mb-8 gap-6 flex-wrap">
          <div className="relative flex-grow">
            <label htmlFor="search-pdi" className="sr-only">Search PDI Reports</label>
            <input
              id="search-pdi"
              ref={searchInputRef}
              type="text"
              placeholder="Search by PDI No., Customer, Status, or Inspected By..."
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

        {isLoading && pdiReports.length > 0 && (
          <div className="text-gray-600 text-lg mb-4 text-center" aria-live="polite">Refreshing data...</div>
        )}

        <div className="bg-white rounded-2xl shadow-lg overflow-x-auto">
          <table className="w-full text-left border-collapse" role="grid" aria-label="PDI Reports table" ref={tableRef} tabIndex={0}>
            <thead>
              <tr className="bg-gradient-to-r from-amber-200 via-amber-100 to-amber-50" role="row">
                {[
                  { key: 'sr_no', label: 'Sr. No.' },
                  { key: 'pdi_no', label: 'PDI No.' },
                  { key: 'customer_name', label: 'Customer' },
                  { key: 'status', label: 'Status' },
                  { key: 'inspected_by', label: 'Inspected By' },
                  { key: 'inspection_date', label: 'Inspection Date' },
                  { key: 'actions', label: 'Actions' },
                ].map(({ key, label }) => (
                  <th
                    key={key}
                    className={`py-5 px-3 text-gray-800 text-base font-semibold ${key !== 'actions' ? 'cursor-pointer hover:bg-amber-300' : ''} transition-all duration-200`}
                    onClick={() => key !== 'actions' && handleSort(key)}
                    aria-sort={sortConfig.key === key ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    scope="col"
                  >
                    <div className="flex items-center justify-between">
                      <span>{label}</span>
                      {key !== 'actions' && (
                        <ArrowDownUp size={16} className={`ml-2 text-gray-600 ${sortConfig.key === key ? 'text-gray-900' : 'opacity-50'}`} aria-hidden="true" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedPdiReports.map((report) => (
                <tr key={report.report_id} className="border-t hover:bg-amber-50 transition-all duration-200" role="row">
                  <td className="py-4 px-3 text-gray-600 text-base">{report.sr_no}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.pdi_no || '\u2014'}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.customer_name || '\u2014'}</td>
                  <td
                    className={`py-4 px-3 text-base ${
                      report.status === 'Completed' ? 'text-green-600' :
                      report.status === 'In Progress' ? 'text-yellow-600' :
                      report.status === 'Failed' ? 'text-red-600' : 'text-gray-600'
                    }`}
                  >
                    {report.status}
                  </td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.inspected_by || 'N/A'}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">{report.inspection_date ? formatDate(report.inspection_date) : 'N/A'}</td>
                  <td className="py-4 px-3 text-gray-600 text-base">
                    <div className="flex items-center gap-1">
                      {canManage ? (
                        <button onClick={() => handleResume(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="Resume in Generator" aria-label={`Resume PDI report ${report.pdi_no || report.report_id}`}>
                          <Pencil size={18} />
                        </button>
                      ) : (
                        <button onClick={() => handleViewDownload(report)} className="p-2 hover:bg-amber-100 rounded-full text-amber-700" title="View / Download PDF" aria-label={`View PDI report ${report.pdi_no || report.report_id}`}>
                          <Eye size={18} />
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

          {totalItems > 0 && (
            <div className="flex justify-between items-center p-4 bg-gray-50">
              <div className="text-gray-600">Showing {sortedPdiReports.length} of {totalItems} PDI reports</div>
              <div className="flex space-x-2">
                <button onClick={handlePrevPage} disabled={cursorHistory.length === 0} className="p-2 bg-white border rounded-lg disabled:opacity-50 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-300" aria-label="Previous page">
                  <ChevronLeft size={20} />
                </button>
                <button onClick={handleNextPage} disabled={!cursor || isLoading} className="p-2 bg-white border rounded-lg disabled:opacity-50 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-300" aria-label="Next page">
                  <ChevronRight size={20} />
                </button>
              </div>
            </div>
          )}

          {!isLoading && sortedPdiReports.length === 0 && (
            <div className="text-center py-12 text-gray-500 flex flex-col items-center" role="status">
              <Search className="mb-4 text-gray-400" size={48} />
              <p className="text-lg">{pdiReports.length === 0 ? 'No PDI reports yet.' : 'No PDI reports found matching your search.'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully. (The component isn't imported anywhere yet, so this only checks the new file itself is syntactically valid and its imports resolve — `lucide-react`'s `Eye`/`Pencil`/`Trash2` icons and `react-router-dom`'s `useNavigate` are both already dependencies used elsewhere in this codebase.)

Also run: `npx eslint src/components/shared/PdiReportsTable.jsx`
Expected: no errors (warnings about the codebase's existing conventions are fine; there should be no unused-variable or hooks-rule errors).

- [ ] **Step 3: Commit**

```bash
git add src/components/shared/PdiReportsTable.jsx
git commit -m "feat: add unified PdiReportsTable component for the reports dashboard"
```

---

## Task 3: `PdiPage.jsx` becomes a thin wrapper

**Files:**
- Modify: `CRM/src/components/admin/PdiPage.jsx` (full rewrite, much shorter)

- [ ] **Step 1: Replace the file's contents**

```jsx
// CRM/src/components/admin/PdiPage.jsx
import React from 'react';
import PdiReportsTable from '../shared/PdiReportsTable';

export default function PdiPage({ socket, userRole }) {
  return <PdiReportsTable socket={socket} userRole={userRole} title="PDI Reports" />;
}
```

Note: Task 2's code review found that `PdiReportsTable` reading the role from `localStorage` at module-load time was a real staleness bug (a role switch via this app's SPA login/logout flow, with no full page reload, wouldn't update which actions a user sees). The fix landed in Task 2: `PdiReportsTable` now accepts an optional `userRole` prop, falling back to `localStorage.getItem('role')` only if none is passed. This wrapper forwards whatever `userRole` it receives from the router (see `routeConfig.jsx`'s `renderRoute(route, userRole, socket)`, which already threads a live role value to route components today).

- [ ] **Step 2: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/components/admin/PdiPage.jsx
git commit -m "refactor: PdiPage becomes a thin wrapper around the shared PdiReportsTable"
```

---

## Task 4: `ProductionPDIPage.jsx` becomes a thin wrapper

**Files:**
- Modify: `CRM/src/components/production/ProductionPDIPage.jsx` (full rewrite, much shorter)

- [ ] **Step 1: Replace the file's contents**

```jsx
// CRM/src/components/production/ProductionPDIPage.jsx
import React from 'react';
import PdiReportsTable from '../shared/PdiReportsTable';

export default function ProductionPDIPage({ socket, userRole }) {
  return <PdiReportsTable socket={socket} userRole={userRole} title="Production PDI Reports" />;
}
```

Note: the original had a `userRole` prop that was destructured but never read in its body — it's now forwarded instead of dropped. See Task 3's note: `PdiReportsTable` accepts an optional `userRole` prop (added during Task 2's code review, to fix a real staleness bug in the old module-scope `localStorage` read), falling back to reading `localStorage` itself only if no prop is passed.

- [ ] **Step 2: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully.

- [ ] **Step 3: Commit**

```bash
git add src/components/production/ProductionPDIPage.jsx
git commit -m "refactor: ProductionPDIPage becomes a thin wrapper around the shared PdiReportsTable"
```

---

## Task 5: Generator form — create-on-open, explicit Save, cancel-cleanup

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

This is the first of three tasks rewiring `PDIGeneratorForm.jsx`. This task covers opening a NEW draft, saving progress, and cleaning up an abandoned never-saved draft on Cancel. Tasks 6 and 7 cover finalize and resume — don't do those yet.

- [ ] **Step 1: Add new state, right after the existing state declarations**

Find this block (near the top of the `PDIGeneratorForm` component function):

```jsx
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('electrical');
  const [form, setForm] = useState(defaultForm);
  const { notifySuccess, notifyError } = useNotify();
  const abortRef = useRef(null);
```

Replace it with:

```jsx
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('electrical');
  const [form, setForm] = useState(defaultForm);
  const [reportId, setReportId] = useState(null);
  // Tracks whether Save has fired at least once on the current draft — a
  // never-saved draft gets deleted on Cancel so opening the form by mistake
  // doesn't leave an empty row behind; once saved, Cancel just closes.
  const [hasSaved, setHasSaved] = useState(false);
  const { notifySuccess, notifyError } = useNotify();
  const abortRef = useRef(null);
```

- [ ] **Step 2: Replace `handleOpen`**

Find:

```jsx
  const handleOpen = () => {
    setForm(defaultForm());
    setActiveTab('electrical');
    setIsOpen(true);
  };
```

Replace with:

```jsx
  const handleOpen = async () => {
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    try {
      const response = await axios.post(`${API_URL}/api/pdi/reports`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setReportId(response.data.report_id);
      setHasSaved(false);
      setForm(defaultForm());
      setActiveTab('electrical');
      setIsOpen(true);
    } catch (err) {
      notifyError(err.response?.data?.error || 'Could not start a new PDI report.');
    }
  };
```

- [ ] **Step 3: Add `handleSave`, right after `handleOpen`**

```jsx
  const handleSave = async () => {
    if (!reportId) return;
    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }
    setSaving(true);
    try {
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, { data, photos, status: 'In Progress' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setHasSaved(true);
      notifySuccess('Progress saved.');
    } catch (err) {
      notifyError(err.response?.data?.error || 'Failed to save progress.');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 4: Replace `handleClose`**

Find:

```jsx
  const handleClose = () => {
    if (abortRef.current) abortRef.current.abort();
    setIsOpen(false);
  };
```

Replace with:

```jsx
  const handleClose = async () => {
    if (abortRef.current) abortRef.current.abort();
    if (reportId && !hasSaved) {
      try {
        const token = localStorage.getItem('token');
        await axios.delete(`${API_URL}/api/pdi/reports/${reportId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.error('Failed to clean up unsaved PDI draft:', err);
      }
    }
    setIsOpen(false);
    setReportId(null);
    setHasSaved(false);
  };
```

- [ ] **Step 5: Add the Save button to the modal footer**

Find the modal footer block:

```jsx
          {/* Modal footer */}
          <div className="flex justify-end gap-3 px-8 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
            <button type="button" onClick={handleClose} className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
            >
              <Download size={16} />
              {loading ? 'Generating PDF...' : 'Generate PDF'}
            </button>
          </div>
```

Replace with (Save pinned to the left, Cancel + Finalize grouped on the right — the button label/text still says "Generate PDF" here; Task 6 renames it to "Finalize & Generate PDF" when it rewires the click handler):

```jsx
          {/* Modal footer */}
          <div className="flex justify-between gap-3 px-8 py-4 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-50 text-sm font-semibold"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <div className="flex gap-3">
              <button type="button" onClick={handleClose} className="px-5 py-2.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
              >
                <Download size={16} />
                {loading ? 'Generating PDF...' : 'Generate PDF'}
              </button>
            </div>
          </div>
```

- [ ] **Step 6: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully. (`handleGenerate` still exists unchanged at this point and still calls the legacy `/api/pdi/generate` endpoint — that's expected, Task 6 replaces it. The app should still fully build and the modal should still open/close/save correctly even though Finalize isn't wired to the new endpoint yet.)

- [ ] **Step 7: Commit**

```bash
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "feat: wire PDI Generator to create-on-open, explicit save, and cancel-cleanup"
```

---

## Task 6: Generator form — Finalize & Generate PDF

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

- [ ] **Step 1: Replace `handleGenerate`**

Find the existing `handleGenerate` function:

```jsx
  const handleGenerate = async (e) => {
    e.preventDefault();
    if (!form.customer_name.trim()) { notifyError('Customer name is required.'); return; }
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }

    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const response = await axios.post(`${API_URL}/api/pdi/generate`, form, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
        signal: controller.signal,
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_${form.pdi_no.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('PDI PDF downloaded successfully.');
      setIsOpen(false);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      // When responseType is 'blob', error bodies arrive as Blobs — parse them back
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to generate PDI PDF.');
        } catch {
          notifyError('Failed to generate PDI PDF.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to generate PDI PDF.');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };
```

Replace it entirely with:

```jsx
  const handleFinalize = async (e) => {
    e.preventDefault();
    if (!form.customer_name.trim()) { notifyError('Customer name is required.'); return; }
    if (!form.pdi_no.trim()) { notifyError('PDI No. is required.'); return; }
    if (!reportId) { notifyError('Report not initialized yet — please close and reopen the form.'); return; }

    const token = localStorage.getItem('token');
    if (!token) { notifyError('Please log in first.'); return; }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      // Finalize renders whatever is currently saved server-side, not the live
      // form state — save first so the PDF reflects exactly what's on screen,
      // even if the user never clicked Save themselves.
      const { photos, ...data } = form;
      await axios.patch(`${API_URL}/api/pdi/reports/${reportId}`, { data, photos }, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      const response = await axios.post(`${API_URL}/api/pdi/reports/${reportId}/finalize`, {}, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
        signal: controller.signal,
      });

      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PDI_${form.pdi_no.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      notifySuccess('PDI finalized and PDF downloaded successfully.');
      setIsOpen(false);
      setReportId(null);
      setHasSaved(false);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      if (err.response?.data instanceof Blob) {
        try {
          const text = await err.response.data.text();
          const parsed = JSON.parse(text);
          notifyError(parsed.error || text || 'Failed to finalize PDI.');
        } catch {
          notifyError('Failed to finalize PDI.');
        }
      } else {
        notifyError(err.response?.data?.error || 'Failed to finalize PDI.');
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };
```

- [ ] **Step 2: Point the form's `onSubmit` at the renamed handler**

Find:

```jsx
        <form onSubmit={handleGenerate}>
```

Replace with:

```jsx
        <form onSubmit={handleFinalize}>
```

- [ ] **Step 3: Update the footer button's label**

Find (inside the footer block Task 5 already restructured):

```jsx
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
              >
                <Download size={16} />
                {loading ? 'Generating PDF...' : 'Generate PDF'}
              </button>
```

Replace with:

```jsx
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 text-sm font-semibold"
              >
                <Download size={16} />
                {loading ? 'Finalizing...' : 'Finalize & Generate PDF'}
              </button>
```

- [ ] **Step 4: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully, no reference to the now-deleted `handleGenerate` remains anywhere in the file (search the file for `handleGenerate` — it should only appear zero times after this step; if any reference remains, the build will fail with an undefined-variable error since it's been fully replaced by `handleFinalize`).

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "feat: wire PDI Generator's Finalize & Generate PDF button to the new finalize endpoint"
```

---

## Task 7: Generator form — resume via `?report=` query param

**Files:**
- Modify: `CRM/src/components/admin/PDIGeneratorForm.jsx`

- [ ] **Step 1: Add the `useSearchParams` import**

Find:

```jsx
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Modal from 'react-modal';
import Cropper from 'react-easy-crop';
import axios from 'axios';
import { Download, FileText, ClipboardCheck, Image as ImageIcon, X, Trash2, Plus, Camera } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';
```

Replace with:

```jsx
import React, { useState, useRef, useCallback, useEffect } from 'react';
import Modal from 'react-modal';
import Cropper from 'react-easy-crop';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, ClipboardCheck, Image as ImageIcon, X, Trash2, Plus, Camera } from 'lucide-react';
import { useNotify } from '../../hooks/useNotify';
```

- [ ] **Step 2: Add the resume effect**

Find the existing cleanup effect near the top of the component body:

```jsx
  // Cancel any in-flight request if the component unmounts
  useEffect(() => () => { abortRef.current?.abort(); }, []);
```

Add the resume effect directly after it:

```jsx
  // Cancel any in-flight request if the component unmounts
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const [searchParams, setSearchParams] = useSearchParams();

  // Resume: if the dashboard linked here with ?report=<id>, load that report
  // and open pre-filled instead of waiting for "+ Create PDI".
  useEffect(() => {
    const resumeId = searchParams.get('report');
    if (!resumeId) return;

    (async () => {
      const token = localStorage.getItem('token');
      if (!token) { notifyError('Please log in first.'); setSearchParams({}, { replace: true }); return; }
      try {
        const response = await axios.get(`${API_URL}/api/pdi/reports/${resumeId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const report = response.data;
        setForm({ ...defaultForm(), ...(report.data || {}), photos: report.photos?.length ? report.photos : defaultForm().photos });
        setReportId(report.report_id);
        // It already exists server-side — Cancel should close, never delete it.
        setHasSaved(true);
        setActiveTab('electrical');
        setIsOpen(true);
      } catch (err) {
        notifyError(err.response?.data?.error || 'Could not load that PDI report.');
      } finally {
        setSearchParams({}, { replace: true });
      }
    })();
    // Only ever run this for the query param present on initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: Verify it builds**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build`
Expected: builds successfully.

Also run: `npx eslint src/components/admin/PDIGeneratorForm.jsx`
Expected: no new errors. The `eslint-disable-next-line react-hooks/exhaustive-deps` comment is required and intentional — this effect must only run once, on mount, to read the URL param that was present when the page loaded.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/PDIGeneratorForm.jsx
git commit -m "feat: resume an existing PDI draft via /pdi-generator?report=<id>"
```

---

## Task 8: Retire the legacy `/api/pdi` system

**Files:**
- Delete: `models/operations/pdi.js`
- Modify: `controllers/operations/pdi.controller.js`
- Modify: `routes/operations/pdi.js`
- Modify: `tests/pdiReports.test.js`

Do this task LAST, after Tasks 2-7 are done and committed — it removes the endpoints the old frontend code used, and by this point nothing calls them anymore. Verified during design that no other file in either repo references `models/operations/pdi.js`, its exports, or these routes beyond the three frontend files already migrated in Tasks 2-7.

- [ ] **Step 1: Write the failing test**

Add to `tests/pdiReports.test.js`, inside the existing `describe` block, after the last `it`:

```js
  it('the legacy /api/pdi generate/CRUD endpoints are gone', async () => {
    const generate = await request(app)
      .post('/api/pdi/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pdi_no: 'PDI-LEGACY-CHECK' });
    expect(generate.statusCode).toBe(404);

    const list = await request(app)
      .get('/api/pdi')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: FAIL — both requests currently succeed (200/201), not 404, since the legacy routes still exist.

- [ ] **Step 3: Delete the legacy model**

```bash
rm models/operations/pdi.js
```

- [ ] **Step 4: Strip the legacy controller down to `getTemplates`**

Replace the full contents of `controllers/operations/pdi.controller.js` with:

```js
exports.getTemplates = async (req, res) => {
  // Forward-compat stub — no template-authoring feature exists yet, so this is
  // always just the one hardcoded template. Real templates would live in a DB
  // table and this would query it instead.
  res.json([{ id: 'general', name: 'General', version: 1 }]);
};
```

- [ ] **Step 5: Strip the legacy routes down to `GET /templates`**

Replace the full contents of `routes/operations/pdi.js` with:

```js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken } = require('../../middleware/auth');
const controller = require('../../controllers/operations/pdi.controller');

router.get('/templates', authenticateToken, controller.getTemplates);

module.exports = router;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: PASS, all 11 tests (10 from before + the new legacy-gone check).

- [ ] **Step 7: Commit**

```bash
git add -A models/operations/pdi.js controllers/operations/pdi.controller.js routes/operations/pdi.js tests/pdiReports.test.js
git commit -m "chore: retire the legacy /api/pdi generate/CRUD system, now fully replaced by /api/pdi/reports"
```

---

## Task 9: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `npx jest tests/pdiReports.test.js --verbose --forceExit`
Expected: all 11 tests passing.

- [ ] **Step 2: Frontend build and lint, both repos' worth of changes**

Run: `cd "c:/Users/Rahul/OneDrive/Desktop/Projects/ERP-CRM/CRM" && npm run build && npm run lint`
Expected: clean build, no new lint errors introduced by this plan's changes (pre-existing warnings elsewhere in the codebase are not this plan's concern).

- [ ] **Step 3: Manual walkthrough**

This repo has no frontend test framework and no guaranteed browser-automation tool in this environment — this step is a real, hands-on walkthrough (by whoever has a browser and a running dev server available) rather than something an agent can fully self-verify. Run `npm run dev` in `CRM` and the backend dev server, log in, and confirm:

1. As `admin` or `production`: open `/pdi-generator`, click "+ Create PDI" — a new row should appear in `/pdi` (or `/production-pdi`) with status `Pending` almost immediately.
2. Fill in Customer Name + PDI No., click **Save** — row status becomes `In Progress`, PDI No./Customer columns populate.
3. Close the browser tab and reopen `/pdi` (or `/production-pdi`) — the draft is still there. Click the **Resume** (pencil) icon on that row — the form reopens pre-filled with everything just entered.
4. Click **Finalize & Generate PDF** — a real PDF downloads, and the row's status becomes `Completed`.
5. As `design` or `dispatch` (who can't reach `/pdi-generator`): open `/pdi`, click the **View** (eye) icon on the completed row — the PDF opens in a new tab, not a login redirect or a broken link.
6. Open `/pdi-generator`, click "+ Create PDI" again, type nothing, click **Cancel** — refresh `/pdi` and confirm no empty row was left behind.
7. As `admin`/`production`, click the **Delete** (trash) icon on any row — confirm the dialog, confirm the row disappears.
8. Confirm `GET /api/pdi/generate` and the old flat `/api/pdi` endpoints are gone from the running app (any lingering bookmark or cached client hitting them should now get a 404, per Task 8's test).
