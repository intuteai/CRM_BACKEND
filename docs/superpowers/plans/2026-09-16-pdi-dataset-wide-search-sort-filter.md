# PDI Records Dataset-Wide Search/Sort/Filter + Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make search, column sort, and the status filter on the PDI Records table operate on the entire dataset via the server (not just the currently-loaded page), add a new server-side template filter and per-row template badge, and refresh the page header/toolbar visuals.

**Architecture:** `pre_dispatch_inspection_reports` gains two real columns (`prepared_by`, `approved_by`), denormalized from the existing regex-based `extractSignerNames(data)` so they're queryable/sortable in SQL. `PdiReports.listReports()` grows `search`, `sortBy`/`sortDir`, and `template_id` params. Default order (no explicit sort) keeps today's cursor/keyset pagination by `report_id DESC`, unchanged. An explicit column sort switches to simple offset pagination across the whole filtered dataset — correct and far simpler than a compound keyset cursor at this table's size (dozens of rows today), avoiding the NULLS-handling complexity that caused the original ordering bug earlier this session. The frontend centralizes "any filter/sort/search changed → reset to page 1 and refetch" into one `useEffect`, replacing the client-side `filteredPdiReports`/`sortedPdiReports` derived arrays entirely (the server now returns exactly what should render).

**Tech Stack:** React (hooks only), `lodash`'s `debounce` (already a dependency, already used this way in `CRM/src/components/admin/InventoryPage.jsx`), PostgreSQL, existing `fetch`-based API client pattern.

**No written spec doc for this round** — design was worked out directly in conversation (including a second round of visual brainstorming via the companion tool) and the user explicitly asked to skip writing a separate spec.md file this time. This plan is the single source of truth.

---

### Task 1: Denormalize `prepared_by`/`approved_by` into real columns

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js`

- [ ] **Step 1: Add the two columns**

This repo has no migration framework — schema changes are one-off scripts run directly against production (see `docs/superpowers/plans/2026-09-04-pdi-reports-backend.md` for precedent). Run from `CRM_BACKEND`:

```bash
node -e "require('dotenv').config(); const pool=require('./config/db'); pool.query(\"ALTER TABLE pre_dispatch_inspection_reports ADD COLUMN IF NOT EXISTS prepared_by TEXT, ADD COLUMN IF NOT EXISTS approved_by TEXT\").then(()=>{console.log('done'); return pool.end();})"
```

Expected output: `done`

- [ ] **Step 2: Verify the columns exist**

```bash
node -e "require('dotenv').config(); const pool=require('./config/db'); pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='pre_dispatch_inspection_reports' AND column_name IN ('prepared_by','approved_by') ORDER BY column_name\").then(r=>{console.log(r.rows.map(x=>x.column_name)); return pool.end();})"
```

Expected output: `[ 'approved_by', 'prepared_by' ]`

- [ ] **Step 3: Write prepared_by/approved_by at write time in `createReport`**

In `CRM_BACKEND/models/operations/pdiReports.js`, change:

```js
  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id }, io) {
    const { templateId, templateVersion } = await this.resolveTemplateVersion(template_id);
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, template_version, data, photos)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      templateId,
      templateVersion,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
    ]);
```

to:

```js
  static async createReport({ customer_id, order_id, inspected_by, inspection_date, data, photos, template_id }, io) {
    const { templateId, templateVersion } = await this.resolveTemplateVersion(template_id);
    const { prepared_by, approved_by } = extractSignerNames(data);
    const result = await pool.query(`
      INSERT INTO pre_dispatch_inspection_reports
        (customer_id, order_id, status, inspected_by, inspection_date, template_id, template_version, data, photos, prepared_by, approved_by)
      VALUES ($1, $2, 'Pending', $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING ${reportColumns()}
    `, [
      customer_id || null,
      order_id || null,
      inspected_by || null,
      inspection_date ? new Date(inspection_date).toISOString() : null,
      templateId,
      templateVersion,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
      prepared_by,
      approved_by,
    ]);
```

- [ ] **Step 4: Write prepared_by/approved_by at write time in `patchReport`**

Change:

```js
    if (fields.data !== undefined) { sets.push(`data = $${i++}`); values.push(JSON.stringify(fields.data)); }
    if (fields.photos !== undefined) { sets.push(`photos = $${i++}`); values.push(JSON.stringify(fields.photos)); }
```

to:

```js
    if (fields.data !== undefined) {
      sets.push(`data = $${i++}`);
      values.push(JSON.stringify(fields.data));
      // Keep the denormalized signer columns in sync with data on every write
      // that touches it -- these two columns can never legitimately drift
      // from what data actually contains.
      const { prepared_by, approved_by } = extractSignerNames(fields.data);
      sets.push(`prepared_by = $${i++}`); values.push(prepared_by);
      sets.push(`approved_by = $${i++}`); values.push(approved_by);
    }
    if (fields.photos !== undefined) { sets.push(`photos = $${i++}`); values.push(JSON.stringify(fields.photos)); }
```

- [ ] **Step 5: Backfill existing reports**

Write a throwaway script (not committed — deleted after running) to `CRM_BACKEND/.tmp-backfill-signers.js`:

```js
require('dotenv').config();
const pool = require('./config/db');

function extractSignerNames(data) {
  if (!data || typeof data !== 'object') return { prepared_by: null, approved_by: null };
  const pick = (pattern) =>
    Object.entries(data)
      .filter(([key, value]) => pattern.test(key) && typeof value === 'string' && value.trim())
      .map(([, value]) => value.trim());
  const prepared = pick(/prepared/i);
  const approved = pick(/approved/i);
  return {
    prepared_by: prepared.length ? prepared.join(' / ') : null,
    approved_by: approved.length ? approved.join(' / ') : null,
  };
}

(async () => {
  const { rows } = await pool.query('SELECT report_id, data FROM pre_dispatch_inspection_reports');
  for (const row of rows) {
    const { prepared_by, approved_by } = extractSignerNames(row.data);
    await pool.query(
      'UPDATE pre_dispatch_inspection_reports SET prepared_by = $1, approved_by = $2 WHERE report_id = $3',
      [prepared_by, approved_by, row.report_id]
    );
  }
  console.log(`Backfilled ${rows.length} reports.`);
  await pool.end();
})();
```

Run it, then delete it:

```bash
node .tmp-backfill-signers.js
rm .tmp-backfill-signers.js
```

Expected output: `Backfilled <N> reports.` where N matches the table's current row count.

- [ ] **Step 6: Verify the backfill against a known report**

```bash
node -e "require('dotenv').config(); const pool=require('./config/db'); pool.query('SELECT report_id, prepared_by, approved_by FROM pre_dispatch_inspection_reports WHERE report_id = 988').then(r=>{console.log(r.rows[0]); return pool.end();})"
```

Expected: `{ report_id: 988, prepared_by: 'Jitendra', approved_by: 'Aditya' }` (per this session's earlier live check of this same report).

- [ ] **Step 7: Switch `listReports`'s read path from computing at read-time to selecting the real columns**

In `listReports`, change the SELECT from:

```js
    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        pdi.data->>'pdi_no' AS pdi_no,
        pdi.data->>'customer_name' AS form_customer_name,
        u.name AS linked_customer_name,
        pdi.data AS data
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE ($1::int IS NULL OR pdi.report_id < $1)
      AND ($3::text IS NULL OR pdi.status = $3)
      ORDER BY pdi.report_id DESC
      LIMIT $2
    `;
```

to:

```js
    const query = `
      SELECT
        pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
        pdi.inspected_by, pdi.inspection_date, pdi.template_id,
        pdi.prepared_by, pdi.approved_by,
        pdi.data->>'pdi_no' AS pdi_no,
        pdi.data->>'customer_name' AS form_customer_name,
        u.name AS linked_customer_name
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE ($1::int IS NULL OR pdi.report_id < $1)
      AND ($3::text IS NULL OR pdi.status = $3)
      ORDER BY pdi.report_id DESC
      LIMIT $2
    `;
```

(`pdi.data AS data` dropped from the SELECT — it was only ever fetched here to compute `prepared_by`/`approved_by` at read time; it isn't part of the response payload otherwise. This shrinks the query payload.)

And change the row-mapping in the `data:` array from:

```js
      data: rows.map((row) => {
        const { prepared_by, approved_by } = extractSignerNames(row.data);
        return {
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
          prepared_by,
          approved_by,
          inspection_date: row.inspection_date,
          report_link: `/api/pdi/reports/${row.report_id}/pdf`,
        };
      }),
```

to:

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
        prepared_by: row.prepared_by,
        approved_by: row.approved_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
```

(`extractSignerNames` itself stays in this file — Steps 3/4 above still call it at write time. Only its read-time call site here is removed.)

- [ ] **Step 8: Lint and verify live**

```bash
cd CRM_BACKEND
node -e "require('./models/operations/pdiReports.js'); console.log('loads OK')"
```

Then verify a real list call still returns correct prepared_by/approved_by (read-only, safe against production):

```bash
node -e "
require('dotenv').config();
const PdiReports = require('./models/operations/pdiReports');
PdiReports.listReports({ limit: 3 }).then(r => { console.log(JSON.stringify(r.data.map(x => ({ id: x.report_id, prepared_by: x.prepared_by, approved_by: x.approved_by })), null, 2)); process.exit(0); });
"
```

Expected: prepared_by/approved_by values matching what was shown in the table before this change (e.g. report with pdi_no HAKO 202609006 → Jitendra/Aditya).

- [ ] **Step 9: Commit**

```bash
cd CRM_BACKEND
git add models/operations/pdiReports.js
git commit -m "$(cat <<'EOF'
feat: denormalize prepared_by/approved_by into real columns

Adds prepared_by/approved_by TEXT columns to pre_dispatch_inspection_reports,
backfilled from existing data via the same extractSignerNames() regex this
file already used at read time. createReport/patchReport now compute and
persist both columns whenever data is written, so they can never drift.
listReports reads the real columns directly instead of recomputing them
per request, and no longer needs to fetch the full data JSONB just for this.

Groundwork for server-side search/sort on these two fields (next commit) --
they weren't real columns before, so neither was possible.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Backend — server-side search, sort, and template filter

**Files:**
- Modify: `CRM_BACKEND/models/operations/pdiReports.js`
- Modify: `CRM_BACKEND/controllers/operations/pdiReports.controller.js`

- [ ] **Step 1: Add the sortable-column allowlist**

In `CRM_BACKEND/models/operations/pdiReports.js`, directly above the `listReports` method, add:

```js
  // Allowlist mapping a client-supplied sortBy key to the exact SQL expression
  // to ORDER BY -- never interpolate a client-supplied column name directly,
  // and only these 7 keys (matching the table's 7 sortable headers) are ever
  // accepted. pdi_no/customer_name stay as JSONB expressions (not denormalized
  // columns) since they were already trivial `->>'key'` extractions -- only
  // prepared_by/approved_by needed denormalizing, because those required
  // extractSignerNames()'s regex logic, which has no simple SQL equivalent.
  static SORTABLE_COLUMNS = {
    sr_no: 'pdi.sr_no',
    pdi_no: "pdi.data->>'pdi_no'",
    customer_name: "COALESCE(pdi.data->>'customer_name', u.name)",
    status: 'pdi.status',
    prepared_by: 'pdi.prepared_by',
    approved_by: 'pdi.approved_by',
    inspection_date: 'pdi.inspection_date',
  };
```

- [ ] **Step 2: Rewrite `listReports`**

Replace the entire `listReports` method (from `static async listReports({ limit = 10, cursor = null, status = null } = {}) {` through its closing `}` before `finalizeReport`) with:

```js
  static async listReports({ limit = 10, cursor = null, offset = 0, status = null, template_id = null, search = null, sortBy = null, sortDir = 'desc' } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);
    const _offset = Math.max(Number(offset) || 0, 0);
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    const sortColumn = sortBy && this.SORTABLE_COLUMNS[sortBy] ? this.SORTABLE_COLUMNS[sortBy] : null;

    const whereParts = [
      '($1::text IS NULL OR pdi.status = $1)',
      '($2::text IS NULL OR pdi.template_id = $2)',
      `($3::text IS NULL OR (
        pdi.data->>'pdi_no' ILIKE '%' || $3 || '%' OR
        COALESCE(pdi.data->>'customer_name', u.name) ILIKE '%' || $3 || '%' OR
        pdi.status ILIKE '%' || $3 || '%' OR
        pdi.prepared_by ILIKE '%' || $3 || '%' OR
        pdi.approved_by ILIKE '%' || $3 || '%'
      ))`,
    ];
    const baseValues = [status || null, template_id || null, search || null];

    const joins = `
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      LEFT JOIN pdi_templates pt ON pt.id = pdi.template_id AND pt.version = pdi.template_version
    `;
    const selectCols = `
      pdi.report_id, pdi.sr_no, pdi.customer_id, pdi.order_id, pdi.status,
      pdi.inspected_by, pdi.inspection_date, pdi.template_id,
      pdi.prepared_by, pdi.approved_by,
      pdi.data->>'pdi_no' AS pdi_no,
      pdi.data->>'customer_name' AS form_customer_name,
      u.name AS linked_customer_name,
      pt.name AS custom_template_name
    `;

    let query, values, useOffset;

    if (sortColumn) {
      // Explicit sort: plain offset pagination across the whole filtered
      // dataset. NULLS LAST keeps unset values (e.g. an abandoned draft with
      // no inspection_date) at the bottom regardless of direction -- same
      // reasoning as the report_id default's earlier NULLS fix, generalized
      // to any column. report_id is a secondary ORDER BY key purely to keep
      // ties (e.g. many "Pending" rows) in a stable order across page loads.
      // Offset (not keyset/cursor) is deliberate here: a compound cursor with
      // generic NULLS-LAST handling across arbitrary column types is real
      // complexity this table's size (dozens of rows) doesn't need yet --
      // the unsorted default keeps its proven cursor pagination below,
      // untouched.
      useOffset = true;
      query = `
        SELECT ${selectCols}
        FROM pre_dispatch_inspection_reports pdi
        ${joins}
        WHERE ${whereParts.join(' AND ')}
        ORDER BY ${sortColumn} ${dir} NULLS LAST, pdi.report_id ${dir}
        LIMIT $4 OFFSET $5
      `;
      values = [...baseValues, _limit + 1, _offset];
    } else {
      // Default order: keyset/cursor pagination by report_id (creation
      // order), unchanged from before this change.
      const cursorReportId = cursor ? parseInt(String(cursor), 10) : null;
      whereParts.push('($4::int IS NULL OR pdi.report_id < $4)');
      useOffset = false;
      query = `
        SELECT ${selectCols}
        FROM pre_dispatch_inspection_reports pdi
        ${joins}
        WHERE ${whereParts.join(' AND ')}
        ORDER BY pdi.report_id DESC
        LIMIT $5
      `;
      values = [...baseValues, Number.isNaN(cursorReportId) ? null : cursorReportId, _limit + 1];
    }

    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM pre_dispatch_inspection_reports pdi
      LEFT JOIN customers c ON pdi.customer_id = c.customer_id
      LEFT JOIN users u ON c.user_id = u.user_id
      WHERE ${whereParts.slice(0, 3).join(' AND ')}
    `;

    const [result, totalResult] = await Promise.all([
      pool.query(query, values),
      pool.query(countQuery, baseValues),
    ]);

    const hasMore = result.rows.length > _limit;
    const rows = hasMore ? result.rows.slice(0, _limit) : result.rows;

    const nextCursor = !useOffset && hasMore ? String(rows[rows.length - 1].report_id) : null;
    const nextOffset = useOffset && hasMore ? _offset + _limit : null;

    return {
      data: rows.map((row) => ({
        report_id: row.report_id,
        sr_no: row.sr_no,
        status: row.status,
        template_id: row.template_id,
        template_name: templates[row.template_id]?.name || row.custom_template_name || row.template_id,
        customer_id: row.customer_id,
        order_id: row.order_id,
        pdi_no: row.pdi_no || null,
        customer_name: row.form_customer_name || row.linked_customer_name || null,
        inspected_by: row.inspected_by,
        prepared_by: row.prepared_by,
        approved_by: row.approved_by,
        inspection_date: row.inspection_date,
        report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      })),
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: nextCursor,
      offset: nextOffset,
    };
  }
```

- [ ] **Step 3: Wire the new query params through the controller**

In `CRM_BACKEND/controllers/operations/pdiReports.controller.js`, change:

```js
exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, status } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, status });
    res.json(result);
  } catch (error) {
```

to:

```js
exports.listReports = async (req, res) => {
  try {
    const { limit = 10, cursor, offset, status, template_id, search, sortBy, sortDir } = req.query;
    const result = await PdiReports.listReports({ limit, cursor, offset, status, template_id, search, sortBy, sortDir });
    res.json(result);
  } catch (error) {
```

- [ ] **Step 4: Lint and verify live**

```bash
cd CRM_BACKEND
node -e "require('./models/operations/pdiReports.js'); console.log('loads OK')"
```

Then, read-only checks against production:

```bash
# Search matches a report whose pdi_no contains "HAKO", regardless of page
node -e "
require('dotenv').config();
const PdiReports = require('./models/operations/pdiReports');
PdiReports.listReports({ limit: 5, search: 'HAKO' }).then(r => { console.log('total:', r.total, 'rows:', r.data.map(x => x.pdi_no)); process.exit(0); });
"

# Sort by customer_name across the whole dataset (offset pagination)
node -e "
require('dotenv').config();
const PdiReports = require('./models/operations/pdiReports');
PdiReports.listReports({ limit: 5, sortBy: 'customer_name', sortDir: 'asc' }).then(r => { console.log('total:', r.total, 'nextOffset:', r.offset, 'rows:', r.data.map(x => x.customer_name)); process.exit(0); });
"

# Template filter
node -e "
require('dotenv').config();
const PdiReports = require('./models/operations/pdiReports');
PdiReports.listReports({ limit: 20, template_id: 'autonxt' }).then(r => { console.log('total:', r.total, 'all autonxt:', r.data.every(x => x.template_id === 'autonxt')); process.exit(0); });
"
```

Expected: search returns only HAKO-matching rows with the correct total; the customer_name sort returns names in ascending order with a numeric `nextOffset` if more than 5 rows exist; the template filter returns only `autonxt` rows.

- [ ] **Step 5: Commit**

```bash
cd CRM_BACKEND
git add models/operations/pdiReports.js controllers/operations/pdiReports.controller.js
git commit -m "$(cat <<'EOF'
feat: server-side search, sort, and template filter for PDI reports

listReports gains search (ILIKE across pdi_no/customer_name/status/
prepared_by/approved_by), sortBy/sortDir (allowlisted columns, offset
pagination across the whole filtered dataset, NULLS LAST), and template_id
(exact match) -- alongside the existing status filter. Default order (no
sortBy) keeps its proven cursor/keyset pagination untouched; only an
explicit column sort switches to offset pagination, which is simpler and
plenty fast at this table's size.

Response also now includes template_name, resolved from the static
templates registry for general/autonxt or a LEFT JOIN to pdi_templates
(matched by id+version, same pairing resolveTemplateVersion already uses)
for admin-authored templates.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — data layer (fetch, state, handlers)

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

- [ ] **Step 1: Add the new imports and state**

Add `debounce` to the imports (below the existing `import { useNotify } ...` line):

```js
import { debounce } from 'lodash';
```

Replace the state block from `const [searchTerm, setSearchTerm] = useState('');` through `const [duplicatingIds, setDuplicatingIds] = useState(() => new Set());` with:

```js
  // searchInput is what's bound to the <input> (updates every keystroke, for
  // a responsive-feeling textbox); searchTerm is the debounced value that
  // actually drives the server query -- same split InventoryPage.jsx already
  // uses elsewhere in this app for the same reason (one network request per
  // pause in typing, not one per keystroke).
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // { key, direction } | null. Unlike before this change, this now drives a
  // real server-side ORDER BY across the whole dataset (not just the loaded
  // page) -- see the offset-pagination branch in fetchPdiReports below.
  const [sortConfig, setSortConfig] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [templateOptions, setTemplateOptions] = useState([]);
  // `cursor` is the token for the NEXT page in the DEFAULT (unsorted) view;
  // `cursorHistory` holds the cursor used to reach each PRIOR page (most
  // recent last); `currentCursor` is whichever cursor produced the page on
  // screen now (null = first page). Only meaningful when sortConfig is null.
  const [cursor, setCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [currentCursor, setCurrentCursor] = useState(null);
  // Offset-pagination equivalents, only meaningful when sortConfig is set
  // (an explicit sort uses OFFSET/LIMIT server-side -- see Task 2).
  const [sortOffset, setSortOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [limit] = useState(10);
  // Report ids with a Duplicate POST currently in flight — unlike Delete
  // (gated by a blocking window.confirm) or View (idempotent), a double-click
  // here would silently create two duplicate reports server-side, so the
  // button disables itself per-row while its own request is outstanding.
  const [duplicatingIds, setDuplicatingIds] = useState(() => new Set());
```

- [ ] **Step 2: Rewrite `fetchPdiReports` to accept an options object**

Replace the entire `fetchPdiReports` `useCallback` with:

```js
  // Returns true on a successful fetch, false on failure — callers that move
  // pagination state (handleNextPage/handlePrevPage) use this to only commit
  // that bookkeeping once the new page has actually loaded, so a failed
  // fetch leaves pagination state exactly as it was for a clean retry.
  const fetchPdiReports = useCallback(
    async ({ cursorToUse = null, offsetToUse = 0, statusToUse, templateToUse, searchToUse, sortByToUse, sortDirToUse } = {}) => {
      if (isFetching.current) return false;
      isFetching.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('token');
        const params = new URLSearchParams({ limit: String(limit) });
        if (sortByToUse) {
          params.set('sortBy', sortByToUse);
          params.set('sortDir', sortDirToUse || 'desc');
          params.set('offset', String(offsetToUse));
        } else if (cursorToUse) {
          params.set('cursor', cursorToUse);
        }
        if (statusToUse) params.set('status', statusToUse);
        if (templateToUse) params.set('template_id', templateToUse);
        if (searchToUse) params.set('search', searchToUse);
        const url = `${BASE_URL}/api/pdi/reports?${params.toString()}`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new Error(errorBody.error || `Server responded with status: ${response.status}`);
        }

        const responseData = await response.json();
        if (!responseData.data || !Array.isArray(responseData.data)) {
          throw new Error('Invalid data format');
        }

        setPdiReports(responseData.data);
        setTotalItems(responseData.total || 0);
        setCursor(responseData.cursor || null);
        setNextOffset(responseData.offset ?? null);
        return true;
      } catch (err) {
        console.error('Error fetching PDI reports:', err);
        const errorMessage = err.message || 'Network error. Please try again later.';
        setError(errorMessage);
        notifyError(errorMessage, { autoClose: 3000 });
        return false;
      } finally {
        setIsLoading(false);
        isFetching.current = false;
      }
    },
    [limit, notifyError]
  );

  // Shared by the mount effect, Refresh, and every filter/sort/search change
  // below -- resets BOTH pagination modes' state (only one is ever "live" at
  // a time, based on whether sortConfig is set) and refetches from page 1
  // with the current filters.
  const fetchFirstPage = useCallback(() => {
    setCursorHistory([]);
    setCurrentCursor(null);
    setSortOffset(0);
    if (sortConfig) {
      return fetchPdiReports({
        offsetToUse: 0,
        statusToUse: statusFilter,
        templateToUse: templateFilter,
        searchToUse: searchTerm,
        sortByToUse: sortConfig.key,
        sortDirToUse: sortConfig.direction,
      });
    }
    return fetchPdiReports({
      cursorToUse: null,
      statusToUse: statusFilter,
      templateToUse: templateFilter,
      searchToUse: searchTerm,
    });
  }, [sortConfig, statusFilter, templateFilter, searchTerm, fetchPdiReports]);
```

- [ ] **Step 3: Replace the mount effect's initial fetch call and add the central refetch effect**

Change:

```js
  useEffect(() => {
    if (!hasFetched.current) {
      fetchPdiReports(null, '');
      hasFetched.current = true;
    }
```

to:

```js
  useEffect(() => {
    if (!hasFetched.current) {
      fetchPdiReports({});
      hasFetched.current = true;
    }
```

(The rest of that `useEffect` — the socket subscription — is unchanged.)

Directly below that `useEffect` (after its closing `}, [fetchPdiReports, socket, providedSocket, notifyInfo]);`), add a new effect:

```js
  // Central "something that changes the RESULT SET changed" handler. Any of
  // these four changing means the current page is stale, so: reset to page
  // 1 (both pagination modes) and refetch. Runs after the mount effect's own
  // first fetch (hasFetched guards that), and after every subsequent change
  // to any of the four.
  useEffect(() => {
    if (!hasFetched.current) return;
    fetchFirstPage();
  }, [statusFilter, templateFilter, searchTerm, sortConfig, fetchFirstPage]);
```

- [ ] **Step 4: Simplify `handleSort`, `handleStatusFilterChange`; add `handleTemplateFilterChange` and debounced search**

Replace:

```js
  const handleSort = useCallback((key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev?.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      setSearchTerm('');
      searchInputRef.current?.focus();
    }
  }, []);
```

with:

```js
  // Unchanged from before this task -- the new central useEffect (Step 3) is
  // what now reacts to sortConfig changing and triggers the server refetch;
  // this handler just toggles the state.
  const handleSort = useCallback((key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev?.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  }, []);

  // No handleStatusFilterChange here -- the status filter renders as pill
  // buttons in Task 4 (not a <select>), so its JSX calls setStatusFilter(value)
  // directly with the pill's own value, no event object to unwrap. The
  // template filter stays a <select>, which does need an onChange wrapper.
  const handleTemplateFilterChange = useCallback((e) => {
    setTemplateFilter(e.target.value);
  }, []);

  // Same debounce pattern already used in CRM/src/components/admin/InventoryPage.jsx:
  // debounce the STATE UPDATE itself (not a fetch call directly), so it never
  // holds a stale closure over the other filters -- the central useEffect
  // above reacts to searchTerm changing with whatever the other filter values
  // currently are.
  const debouncedSetSearchTerm = useCallback(debounce((value) => setSearchTerm(value), 400), []);

  const handleSearchChange = useCallback(
    (e) => {
      const value = e.target.value;
      setSearchInput(value);
      debouncedSetSearchTerm(value);
    },
    [debouncedSetSearchTerm]
  );

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      setSearchInput('');
      setSearchTerm('');
      searchInputRef.current?.focus();
    }
  }, []);
```

- [ ] **Step 5: Remove the now-obsolete client-side filter/sort `useMemo`s**

Delete these two blocks entirely:

```js
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
        String(item.prepared_by || ''),
        String(item.approved_by || ''),
      ];
      return searchFields.some((field) => field.toLowerCase().includes(searchTerm.toLowerCase()));
    });
  }, [pdiReports, searchTerm]);

  const sortedPdiReports = useMemo(() => {
    if (!filteredPdiReports.length) return [];
    if (!sortConfig) return filteredPdiReports; // preserve the server's own order
    return [...filteredPdiReports].sort((a, b) => {
      const valueA = a[sortConfig.key] ?? '';
      const valueB = b[sortConfig.key] ?? '';
      if (valueA < valueB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valueA > valueB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredPdiReports, sortConfig]);
```

`pdiReports` from the server is now already filtered, searched, and sorted exactly as it should render — Task 4 renders it directly. (`useMemo` stays imported and used elsewhere in this file? No — check: after this removal, confirm no other `useMemo` call remains other than the `socket` one already using `useMemo`. It does — the `socket` memo stays untouched.)

- [ ] **Step 6: Make `handlePrevPage`/`handleNextPage`/`handleRefresh` mode-aware, and simplify the two filter handlers' old bodies**

Replace `handlePrevPage` through `handleStatusFilterChange` (i.e. everything from `const handlePrevPage = useCallback(...)` through the old `handleStatusFilterChange`'s closing `);`) with:

```js
  const handlePrevPage = useCallback(async () => {
    if (sortConfig) {
      const prevOffset = Math.max(0, sortOffset - limit);
      const succeeded = await fetchPdiReports({
        offsetToUse: prevOffset,
        statusToUse: statusFilter,
        templateToUse: templateFilter,
        searchToUse: searchTerm,
        sortByToUse: sortConfig.key,
        sortDirToUse: sortConfig.direction,
      });
      if (succeeded) setSortOffset(prevOffset);
      return;
    }
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1];
    const succeeded = await fetchPdiReports({
      cursorToUse: prevCursor,
      statusToUse: statusFilter,
      templateToUse: templateFilter,
      searchToUse: searchTerm,
    });
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => h.slice(0, -1));
    setCurrentCursor(prevCursor);
  }, [sortConfig, sortOffset, limit, cursorHistory, fetchPdiReports, statusFilter, templateFilter, searchTerm]);

  const handleNextPage = useCallback(async () => {
    if (sortConfig) {
      if (nextOffset == null || isLoading) return;
      const succeeded = await fetchPdiReports({
        offsetToUse: nextOffset,
        statusToUse: statusFilter,
        templateToUse: templateFilter,
        searchToUse: searchTerm,
        sortByToUse: sortConfig.key,
        sortDirToUse: sortConfig.direction,
      });
      if (succeeded) setSortOffset(nextOffset);
      return;
    }
    if (!cursor || isLoading) return;
    const targetCursor = cursor;
    const previousCursor = currentCursor;
    const succeeded = await fetchPdiReports({
      cursorToUse: targetCursor,
      statusToUse: statusFilter,
      templateToUse: templateFilter,
      searchToUse: searchTerm,
    });
    if (!succeeded) return; // leave cursorHistory/currentCursor untouched so retry/Prev stay correct
    setCursorHistory((h) => [...h, previousCursor]);
    setCurrentCursor(targetCursor);
  }, [sortConfig, nextOffset, isLoading, cursor, currentCursor, fetchPdiReports, statusFilter, templateFilter, searchTerm]);

  const handleRefresh = useCallback(() => {
    fetchFirstPage();
  }, [fetchFirstPage]);
```

(`handleStatusFilterChange`/`handleTemplateFilterChange` were already defined in Step 4 — don't redefine them here.)

- [ ] **Step 7: Fetch the template list for the filter dropdown**

Directly below the effect added in Step 3, add:

```js
  // Populates the Template filter dropdown. Reuses the same endpoint
  // PdiTemplatePicker.jsx already calls (GET /api/pdi/templates -- code
  // templates + every active admin-authored one, [{id, name, version}]).
  // Non-critical: if it fails, the dropdown just stays at "All templates"
  // only -- the reports table itself doesn't depend on this list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${BASE_URL}/api/pdi/templates`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok || cancelled) return;
        const list = await response.json();
        if (!cancelled) setTemplateOptions(list);
      } catch (err) {
        console.error('Error loading PDI template list:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 8: Fix the `ConnectionError` retry call**

Change:

```js
  if (error && !pdiReports.length) return <ConnectionError onRetry={() => fetchPdiReports(null, statusFilter)} />;
```

to:

```js
  if (error && !pdiReports.length) return <ConnectionError onRetry={fetchFirstPage} />;
```

- [ ] **Step 9: Lint**

Run: `cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx`

Expected at this point: errors about `sortedPdiReports`/`filteredPdiReports` being undefined in the JSX (Task 4 fixes the render code that still references them) — that's expected and resolved by the next task, not a mistake in this one. No OTHER errors should appear (no unused-var warnings for anything defined in this task, no syntax errors).

- [ ] **Step 10: Commit**

```bash
cd CRM
git add src/components/shared/PdiReportsTable.jsx
git commit -m "$(cat <<'EOF'
feat: PDI Records data layer -- server-side search/sort/template filter

fetchPdiReports moves from positional args to an options object (grew from
2 params to 7) and gains a dual pagination mode: cursor-based for the
default unsorted view (unchanged), offset-based when an explicit column
sort is active (new -- matches the backend's listReports change). Search
input is now split into an immediate searchInput (bound to the textbox) and
a 400ms-debounced searchTerm that drives the query, same pattern already
used in InventoryPage.jsx. A single central useEffect now reacts to any of
{statusFilter, templateFilter, searchTerm, sortConfig} changing by
resetting to page 1 and refetching, replacing four different handlers that
each used to do their own reset-and-fetch. The old filteredPdiReports/
sortedPdiReports client-side derived arrays are removed -- the server now
returns exactly what should render.

Note: this commit alone will show lint errors in the render code still
referencing the removed sortedPdiReports/filteredPdiReports -- fixed in the
next commit (visual layer).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Frontend — visual layer (header, toolbar, badges, render fixes)

**Files:**
- Modify: `CRM/src/components/shared/PdiReportsTable.jsx`

- [ ] **Step 1: Add a `ClipboardList` icon import**

Change:

```js
import { ArrowDownUp, Search, Eye, Pencil, Trash2, Copy } from 'lucide-react';
```

to:

```js
import { ArrowDownUp, Search, Eye, Pencil, Trash2, Copy, ClipboardList } from 'lucide-react';
```

- [ ] **Step 2: Add status-pill-row and template-badge style constants**

Directly below the existing `getStatusStyle` function (before `ReportActions`), add:

```js
const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'Pending', label: 'Pending' },
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Failed', label: 'Failed' },
];

// Per-row template badge (next to PDI No.) -- General/AutoNXT get fixed
// colors since they're the two known hardcoded templates; any admin-authored
// custom template shares one color rather than assigning one per template
// (an unbounded, admin-created set).
const TEMPLATE_BADGE_STYLES = {
  general: 'bg-indigo-50 text-indigo-700',
  autonxt: 'bg-pink-50 text-pink-700',
};
const DEFAULT_TEMPLATE_BADGE_STYLE = 'bg-teal-50 text-teal-700';

function getTemplateBadgeStyle(templateId) {
  return TEMPLATE_BADGE_STYLES[templateId] || DEFAULT_TEMPLATE_BADGE_STYLE;
}
```

- [ ] **Step 3: Replace the page header**

Change:

```jsx
      <h1 className="text-4xl font-bold text-gray-800 mb-10 text-center tracking-tight">{title}</h1>
```

to:

```jsx
      <div className="max-w-7xl mx-auto mb-8">
        <div className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-2xl shadow-sm px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center rounded-2xl bg-gray-800 text-white mb-3 shadow-lg" style={{ width: 52, height: 52 }}>
            <ClipboardList size={24} />
          </div>
          <h1 className="text-3xl font-extrabold text-gray-800 tracking-tight">{title}</h1>
          <p className="text-gray-500 text-sm mt-1.5">Pre-dispatch inspection records across all customers and templates</p>
        </div>
      </div>
```

- [ ] **Step 4: Replace the toolbar (search/filter/refresh block)**

Change the entire block from `<div className="flex mb-8 gap-6 flex-wrap">` through its matching closing `</div>` (the one right before the removed note-line block) to:

```jsx
        <div className="flex gap-3 mb-4">
          <div className="relative flex-grow">
            <label htmlFor="search-pdi" className="sr-only">Search PDI Reports</label>
            <input
              id="search-pdi"
              ref={searchInputRef}
              type="text"
              placeholder="Search by PDI No., Customer, Status, Prepared By, or Approved By..."
              value={searchInput}
              onChange={handleSearchChange}
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

        <div className="flex flex-wrap items-center gap-2 mb-8">
          <span className="text-xs uppercase font-bold text-gray-400 tracking-wide mr-1">Status</span>
          {STATUS_FILTER_OPTIONS.map(({ value, label }) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              disabled={isLoading}
              className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                statusFilter === value
                  ? 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="w-px h-5 bg-gray-200 mx-1" aria-hidden="true" />
          <label htmlFor="template-filter-pdi" className="text-xs uppercase font-bold text-gray-400 tracking-wide mr-1">Template</label>
          <select
            id="template-filter-pdi"
            value={templateFilter}
            onChange={handleTemplateFilterChange}
            disabled={isLoading}
            className="px-3 py-1.5 rounded-full text-xs font-semibold border border-gray-200 bg-white text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
          >
            <option value="">All templates</option>
            {templateOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
```

- [ ] **Step 5: Remove the "search/sort only applies to this page" note**

Delete this block entirely (it directly follows the toolbar):

```jsx
        {totalItems > pdiReports.length && (
          <div className="text-gray-500 text-sm -mt-5 mb-6">
            Search and column sorting only apply to the {pdiReports.length} reports currently loaded on this page, not the full {totalItems}.
          </div>
        )}
```

- [ ] **Step 6: Render `pdiReports` directly and add the template badge (desktop table)**

Change:

```jsx
              <tbody>
                {/* Field fallbacks ('—'/'N/A') here must match the md:hidden card list below -- kept as two plain JSX blocks per the CSS-only breakpoint-switch design, not a shared render function. */}
                {sortedPdiReports.map((report) => (
                  <tr key={report.report_id} className={`border-t border-l-4 ${getStatusStyle(report.status).border} hover:bg-amber-50 transition-all duration-200`} role="row">
                    <td className="py-4 px-3 text-gray-600 text-base">{report.sr_no}</td>
                    <td className="py-4 px-3 text-gray-600 text-base">{report.pdi_no || '—'}</td>
```

to:

```jsx
              <tbody>
                {/* Field fallbacks ('—'/'N/A') here must match the md:hidden card list below -- kept as two plain JSX blocks per the CSS-only breakpoint-switch design, not a shared render function. */}
                {pdiReports.map((report) => (
                  <tr key={report.report_id} className={`border-t border-l-4 ${getStatusStyle(report.status).border} hover:bg-amber-50 transition-all duration-200`} role="row">
                    <td className="py-4 px-3 text-gray-600 text-base">{report.sr_no}</td>
                    <td className="py-4 px-3 text-gray-600 text-base">
                      {report.pdi_no || '—'}
                      <span className={`ml-2 inline-block px-2 py-0.5 rounded text-[10px] font-bold align-middle ${getTemplateBadgeStyle(report.template_id)}`}>
                        {report.template_name}
                      </span>
                    </td>
```

- [ ] **Step 7: Render `pdiReports` directly and add the template badge (mobile card)**

Change:

```jsx
            {sortedPdiReports.map((report) => (
              <div key={report.report_id} className={`p-4 border-t-gray-100 border-l-4 ${getStatusStyle(report.status).border}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-gray-800 text-base">{report.pdi_no || '—'}</span>
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${getStatusStyle(report.status).pill}`}>
                    {report.status}
                  </span>
                </div>
```

to:

```jsx
            {pdiReports.map((report) => (
              <div key={report.report_id} className={`p-4 border-t-gray-100 border-l-4 ${getStatusStyle(report.status).border}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-bold text-gray-800 text-base">
                    {report.pdi_no || '—'}
                    <span className={`ml-2 inline-block px-2 py-0.5 rounded text-[10px] font-bold align-middle ${getTemplateBadgeStyle(report.template_id)}`}>
                      {report.template_name}
                    </span>
                  </span>
                  <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${getStatusStyle(report.status).pill}`}>
                    {report.status}
                  </span>
                </div>
```

- [ ] **Step 8: Fix the remaining `sortedPdiReports` references (footer count, prev/next disabled state, empty state)**

Change:

```jsx
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

to:

```jsx
          {totalItems > 0 && (
            <div className="flex justify-between items-center p-4 bg-gray-50">
              <div className="text-gray-600">Showing {pdiReports.length} of {totalItems} PDI reports</div>
              <div className="flex space-x-2">
                <button
                  onClick={handlePrevPage}
                  disabled={sortConfig ? sortOffset === 0 : cursorHistory.length === 0}
                  className="p-2 bg-white border rounded-lg disabled:opacity-50 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-300"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  onClick={handleNextPage}
                  disabled={sortConfig ? nextOffset == null || isLoading : !cursor || isLoading}
                  className="p-2 bg-white border rounded-lg disabled:opacity-50 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-amber-300"
                  aria-label="Next page"
                >
                  <ChevronRight size={20} />
                </button>
              </div>
            </div>
          )}

          {!isLoading && pdiReports.length === 0 && (
            <div className="text-center py-12 text-gray-500 flex flex-col items-center" role="status">
              <Search className="mb-4 text-gray-400" size={48} />
              <p className="text-lg">
                {totalItems === 0 && !statusFilter && !templateFilter && !searchTerm
                  ? 'No PDI reports yet.'
                  : 'No PDI reports match your search and filters.'}
              </p>
            </div>
          )}
```

- [ ] **Step 9: Lint**

Run: `cd CRM && npx eslint src/components/shared/PdiReportsTable.jsx`
Expected: no output (clean) — this is the commit where the Task 3 lint errors from removing `sortedPdiReports`/`filteredPdiReports` get resolved.

- [ ] **Step 10: Commit**

```bash
cd CRM
git add src/components/shared/PdiReportsTable.jsx
git commit -m "$(cat <<'EOF'
feat: PDI Records visual refresh -- header, toolbar, template badges

Header: icon badge + title + subtitle, centered, on a gradient card.
Toolbar: two rows -- full-width search + refresh, then status as clickable
pill chips (replacing the <select>) sharing a row with a new Template
dropdown filter, divided by a thin rule. Per-row template badge (General/
AutoNXT/custom, color-coded) added next to PDI No. in both the desktop
table and mobile cards, using template_name from the backend (previous
commit). Removes the "search/sort only applies to this page" note -- no
longer true, everything's server-side now. Table/cards render pdiReports
directly (server-filtered/sorted/paginated) instead of the removed
sortedPdiReports/filteredPdiReports client derived arrays.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Live verification (controller-personal, not a subagent)

Do this yourself in the current session — it needs live judgment about what's on screen and involves live production data.

- [ ] **Step 1: Read the full file once more end-to-end** after Tasks 1-4 to confirm the merged result is coherent (no leftover references to `sortedPdiReports`/`filteredPdiReports`, no stale imports).

- [ ] **Step 2: Start a local dev server pair** (production frontend won't reflect this until pushed+deployed) — same setup as earlier this session:
  - `CRM_BACKEND`: `FRONTEND_URL=http://localhost:5173 npm run dev` (the CORS override is required for a locally-run CRM frontend to call a locally-run backend; check nothing is already bound to port 8000 first, per this session's earlier EADDRINUSE lesson).
  - `CRM`: `npm run dev` (reads `.env.local`'s `VITE_BACKEND_URL=http://localhost:8000`).
  - Both connect to the same production RDS database — no separate staging DB.

- [ ] **Step 3: Desktop check (~1280px) via gstack browse**, logged in as `admin@compageauto.com`:
  - Header renders with the icon badge, title, subtitle.
  - Status pills and Template dropdown share one row; clicking a status pill actually narrows results server-side (compare total before/after) and highlights the active pill; picking a template does the same.
  - Search: type something matching a report NOT on the currently-loaded first page (e.g. a customer name only present on page 2) — confirm it's found (proves server-side, not client-side) and that it only fires ~400ms after typing stops, not on every keystroke (watch the network tab / request count).
  - Column sort: click at least two different sortable headers (e.g. Customer, Prepared By) beyond the default — confirm the full dataset re-orders correctly, Sr. No no longer needs to look sequential (that's expected now — it's an explicit user-chosen sort), and Prev/Next page through the sorted view without duplicate or missing rows at the page boundary.
  - Per-row template badge shows the correct name for a General, an AutoNXT, and a custom-template report.
  - Combine a status filter AND a template filter AND a sort AND a search term together — confirm they all AND together correctly and pagination still works.
  - Empty state: pick a combination with zero matches, confirm the new generic message appears.

- [ ] **Step 4: Mobile check (~375px) via gstack browse**:
  - Template badge appears correctly in the card's top row next to PDI No.
  - No horizontal scroll introduced by the badge.
  - Status pills / template dropdown wrap sensibly at this width.

- [ ] **Step 5: Verify the backfill one more time end-to-end** through the UI itself: search for a known signer name (e.g. "Jitendra") with no other filters active, confirm the matching report(s) are returned.

- [ ] **Step 6: Fix anything found**, re-run lint, commit the fix with its own message.

- [ ] **Step 7: Stop both local dev servers** and confirm no test data was created (this task is read-only verification; if any `ZZTEST`-prefixed throwaway data was created to hit an edge case, delete it and confirm the total report count matches what it was before this task started).
