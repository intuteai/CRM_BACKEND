const pool = require('../../config/db');
const logger = require('../../utils/logger');
const PDIGenerator = require('./pdi_generator');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');
const templates = require('./pdi/templates');
const AuthoredTemplates = require('./pdi/authoredTemplates');
const pdfCache = require('./pdi/pdfCache');

// How many photos a report holds, for the finalize/PDF timing log: a freeform
// list of { images: [...] } entries, or a fixed-slots map of slot -> uri | [uri].
function countPhotos(photos) {
  const countOf = (v) => (Array.isArray(v) ? v.length : (v ? 1 : 0));
  if (Array.isArray(photos)) return photos.reduce((n, p) => n + (Array.isArray(p?.images) ? p.images.length : 0), 0);
  if (photos && typeof photos === 'object') return Object.values(photos).reduce((n, v) => n + countOf(v), 0);
  return 0;
}

// The mobile app's inspection-date field is free text (placeholder
// "YYYY-MM-DD", nothing stops other input) -- a value like "22-09-2026",
// typed day-first as is natural for an Indian user, produces an Invalid
// Date. `new Date(...).toISOString()` on that throws RangeError, and
// previously that was never caught here specifically: it fell into the
// generic try/catch and came back as an opaque 500 "Internal Server Error"
// with no way for the client to know the date field was the problem.
// Reproduced live against report #1059 -- every save from the moment the
// date field held that value failed identically, 4ms in, never touching
// the database.
function toIsoDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid inspection date: "${value}". Use YYYY-MM-DD.`);
    error.code = 'INVALID_INSPECTION_DATE';
    throw error;
  }
  return parsed.toISOString();
}

// Every template's signature roles follow the same naming convention this
// whole dialect already uses everywhere (General's prepared_by/approved_by,
// AutoNXT's prepared_by_electrical/prepared_by_mechanical/approved_by, and
// any admin-authored template — its role keys are auto-slugified from labels
// like "Prepared By" via CRM/src/utils/pdiTemplateSlug.js, landing on the
// same pattern). So rather than hardcode per-template field lists, this scans
// whatever keys the report's own data actually has. AutoNXT's two preparer
// roles both match "prepared" and get joined, since there's no single name
// to prefer between them.
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

// Collects a PDFKit document's output into a single Buffer.
function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// `photos` as [{ id, label, image_count }] with no image data, worked out inside
// Postgres so the (often 20-40 MB) photo value is never sent to Node, parsed, or
// sent on to the phone. Handles both stored shapes: a freeform list of
// { id, label, images: [...] } and a fixed-slots map of slot -> uri | [uri] | null.
function photosSummarySql(p) {
  return `(
    SELECT COALESCE(jsonb_agg(s.item ORDER BY s.ord), '[]'::jsonb) FROM (
      SELECT t.ord AS ord, jsonb_build_object(
        'id', COALESCE(t.e->>'id', ''),
        'label', COALESCE(t.e->>'label', ''),
        'image_count', CASE WHEN jsonb_typeof(t.e->'images') = 'array' THEN jsonb_array_length(t.e->'images') ELSE 0 END
      ) AS item
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${p}photos) = 'array' THEN ${p}photos ELSE '[]'::jsonb END)
        WITH ORDINALITY AS t(e, ord)
      WHERE jsonb_typeof(t.e) = 'object'
      UNION ALL
      SELECT 1000000 + row_number() OVER (), jsonb_build_object(
        'id', o.k, 'label', o.k,
        'image_count', CASE jsonb_typeof(o.v) WHEN 'array' THEN jsonb_array_length(o.v) WHEN 'string' THEN 1 ELSE 0 END
      )
      FROM jsonb_each(CASE WHEN jsonb_typeof(${p}photos) = 'object' THEN ${p}photos ELSE '{}'::jsonb END) AS o(k, v)
    ) s
  ) AS photos`;
}

function reportColumns(prefix = '', { photosSummary = false } = {}) {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}report_id, ${p}sr_no, ${p}customer_id, ${p}order_id, ${p}status,
    ${p}inspected_by, ${p}inspection_date, ${p}template_id, ${p}template_version, ${p}drive_file_id,
    ${p}data, ${photosSummary ? photosSummarySql(p) : `${p}photos`}
  `;
}

class PdiReports {
  static #toPayload(row) {
    return {
      report_id: row.report_id,
      sr_no: row.sr_no,
      status: row.status,
      template_id: row.template_id,
      template_version: row.template_version,
      customer_id: row.customer_id,
      order_id: row.order_id,
      inspected_by: row.inspected_by,
      inspection_date: row.inspection_date,
      report_link: `/api/pdi/reports/${row.report_id}/pdf`,
      drive_file_id: row.drive_file_id,
      data: row.data,
      photos: row.photos,
    };
  }

  // Resolves a caller-supplied template_id into the exact (template_id, template_version)
  // pair to store on a new report. Code-registered templates (general, autonxt, ...)
  // aren't versioned at the DB level, so template_version stays null for them; a
  // DB-authored template pins to whichever version is currently 'active'. This lives
  // here (not just in the controller) so ANY future caller of createReport gets this
  // validation enforced automatically, rather than needing to duplicate the check
  // before calling in — see the code review on commit 878869e for why this matters.
  static async resolveTemplateVersion(templateId) {
    const id = templateId || 'general';
    if (templates[id]) return { templateId: id, templateVersion: null };
    const active = await AuthoredTemplates.getActive(id);
    if (!active) throw new Error(`Unknown PDI template: ${id}`);
    return { templateId: id, templateVersion: active.version };
  }

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
      toIsoDateOrNull(inspection_date),
      templateId,
      templateVersion,
      JSON.stringify(data || {}),
      JSON.stringify(photos || []),
      prepared_by,
      approved_by,
    ]);

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }

  // "Duplicate as New PDI" — starts a new report from a completed/in-progress
  // one for a similar customer/product. Resets everything that's specific to
  // the physical unit(s) actually tested (pdi_no, inspection_date, photos,
  // every table/checklist/fill-in-list row, signatures); carries forward
  // everything else in `data` unchanged (Customer Name, Product ID, Drawing
  // No, Product Specifications, and — for General specifically — the
  // tolerance/spec-row fields, since those describe the whole batch, not one
  // motor). customer_id/order_id carry forward too (same customer/order);
  // inspected_by/status/created_at are freshly assigned via createReport,
  // same as any brand-new report.
  static async duplicateReport(reportId, inspectedBy, io) {
    const source = await this.getById(reportId);
    const sourceData = source.data || {};

    // Reset: pdi_no, date, every table's rows, every signature field, general
    // check results. Keep everything else (Header-level identity/spec fields).
    // Field names differ per hard-coded template, so the reset set is keyed by
    // template_id — General and AutoNXT each define their own per-run fields.
    const RESET_KEYS_BY_TEMPLATE = {
      general: [
        'pdi_no', 'date',
        'rows', // General's electrical/mechanical motor rows
        'prepared_by', 'approved_by', // General's signatures
        'general_electrical', 'general_mechanical', // General's fixed GO/NG checks
        'electrical_remarks', 'mechanical_remarks', // per-run remarks, not batch spec
      ],
      autonxt: [
        'pdi_no', 'date', 'motor_sr_no',
        'performance_test', 'general_check', 'physical_parameters', // AutoNXT's measured checklists
        'page1_remarks', 'page2_remarks', // per-run remarks, not batch spec
        'prepared_by_electrical', 'prepared_by_mechanical', 'approved_by', // AutoNXT's signatures
      ],
    };
    // Admin-authored templates aren't in this map yet — their per-run fields
    // are admin-defined (arbitrary dataKeys per section), so only pdi_no/date
    // reset for those; everything else still carries forward unchanged.
    const resetKeys = new Set(RESET_KEYS_BY_TEMPLATE[source.template_id] || ['pdi_no', 'date']);
    const newData = {};
    for (const [key, value] of Object.entries(sourceData)) {
      if (!resetKeys.has(key)) newData[key] = value;
    }

    return this.createReport({
      customer_id: source.customer_id,
      order_id: source.order_id,
      inspected_by: inspectedBy,
      data: newData,
      photos: [],
      template_id: source.template_id,
    }, io);
  }

  // { photosSummary: true } returns `photos` as [{ id, label, image_count }]
  // instead of the stored images -- see photosSummarySql.
  static async getById(reportId, { photosSummary = false } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(`SELECT ${reportColumns('', { photosSummary })} FROM pre_dispatch_inspection_reports WHERE report_id = $1`, [_id]);
    if (result.rows.length === 0) throw new Error('Report not found');
    return this.#toPayload(result.rows[0]);
  }

  // `options.photosSummary`: answer with photo counts instead of the photos
  // themselves (the save is unaffected -- `fields.photos` is still stored in full).
  static async patchReport(reportId, fields, io, { photosSummary = false } = {}) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');

    const sets = [];
    const values = [];
    let i = 1;

    if (fields.status !== undefined) { sets.push(`status = $${i++}`); values.push(fields.status); }
    if (fields.inspected_by !== undefined) { sets.push(`inspected_by = $${i++}`); values.push(fields.inspected_by || null); }
    if (fields.inspection_date !== undefined) {
      sets.push(`inspection_date = $${i++}`);
      values.push(toIsoDateOrNull(fields.inspection_date));
    }
    if (fields.customer_id !== undefined) { sets.push(`customer_id = $${i++}`); values.push(fields.customer_id || null); }
    if (fields.order_id !== undefined) { sets.push(`order_id = $${i++}`); values.push(fields.order_id || null); }
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
    if (fields.photos !== undefined) {
      // Clients (notably the mobile app) re-send the whole photo set on every
      // save, even when only electrical/mechanical data changed. Writing a
      // multi-MB jsonb value costs seconds of TOAST/WAL work each time, and a
      // retried save queues behind the previous one on the same row. When the
      // incoming photos equal what's stored, keep the existing value: `photos`
      // in the THEN branch is the stored datum itself, so Postgres reuses its
      // TOAST pointer instead of rewriting it.
      sets.push(`photos = CASE WHEN photos = $${i}::jsonb THEN photos ELSE $${i}::jsonb END`);
      values.push(JSON.stringify(fields.photos));
      i++;
    }

    if (sets.length === 0) return this.getById(_id, { photosSummary });

    values.push(_id);
    // AND status <> 'Completed' -- a finalized report is locked against
    // further writes. Without this, a stale save-draft request from a
    // second device/tab that hasn't caught up with another device's
    // finalize (exactly the kind of delayed/retried write the client-side
    // timeout and retry work elsewhere is meant to tolerate) can silently
    // overwrite a Completed report's data/photos with older content and
    // even revert its status -- reproduced directly against this endpoint
    // during the investigation that led to this guard. No error, no trace,
    // just a "disappeared" finalized report. If a finalized report genuinely
    // needs correcting, Duplicate it into a new report instead of editing
    // the finalized one in place.
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET ${sets.join(', ')}
      WHERE report_id = $${i} AND status <> 'Completed'
      RETURNING ${reportColumns('', { photosSummary })}
    `, values);

    if (result.rows.length === 0) {
      // Only asking "does it exist?" -- never worth loading its photos for.
      const existing = await this.getById(_id, { photosSummary: true }).catch(() => null);
      if (!existing) throw new Error('Report not found');
      const lockedError = new Error('This report is already finalized and can no longer be edited. Duplicate it to make changes.');
      lockedError.code = 'REPORT_LOCKED';
      throw lockedError;
    }

    const payload = this.#toPayload(result.rows[0]);
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });
    return payload;
  }

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

  static async listReports({ limit = 10, cursor = null, offset = 0, status = null, template_id = null, search = null, sortBy = null, sortDir = 'desc' } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);
    const _offset = Math.max(Number(offset) || 0, 0);
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
    const sortColumn = sortBy && Object.prototype.hasOwnProperty.call(this.SORTABLE_COLUMNS, sortBy)
      ? this.SORTABLE_COLUMNS[sortBy]
      : null;

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

  static async finalizeReport(reportId, io) {
    const started = Date.now();
    const timings = {};

    let t = Date.now();
    const report = await this.getById(reportId);
    timings.loadMs = Date.now() - t;
    timings.photos = countPhotos(report.photos);

    if (!report.data?.pdi_no) {
      const missing = new Error('pdi_no required before finalizing');
      missing.code = 'PDI_NO_REQUIRED';
      throw missing;
    }

    // Same lock as patchReport -- a second/stale device re-finalizing an
    // already-Completed report would waste a PDF regeneration and Drive
    // upload, and re-finalizing isn't how you recover a lost PDF anyway
    // (that's getPdfBuffer / GET .../pdf, which is read-only). If a report
    // needs correcting after finalize, Duplicate it instead.
    if (report.status === 'Completed') {
      const lockedError = new Error('This report is already finalized.');
      lockedError.code = 'REPORT_LOCKED';
      throw lockedError;
    }

    // photos live in their own column, not report.data — the generator reads
    // data.photos, so it has to be merged in here or PDFs render with none.
    t = Date.now();
    const generateTimings = {};
    const pdfBuffer = await bufferPdf(await PDIGenerator.generate(
      report.template_id, report.template_version,
      { ...(report.data || {}), photos: report.photos || [] },
      { timings: generateTimings },
    ));
    timings.renderMs = Date.now() - t; // includes the photo downscale below
    timings.optimize = generateTimings.optimize || null;
    timings.pdfBytes = pdfBuffer.length;

    // No `photos` in RETURNING: the UPDATE doesn't touch them, and reading a
    // multi-MB column back just to hand it to a caller that only wants the id
    // and status is pure waste. `report` (already loaded) supplies the rest.
    // `AND status <> 'Completed'` closes the window where two finalizes that
    // both passed the check above would each generate and upload a PDF.
    t = Date.now();
    const result = await pool.query(`
      UPDATE pre_dispatch_inspection_reports
      SET status = 'Completed'
      WHERE report_id = $1 AND status <> 'Completed'
      RETURNING report_id, status
    `, [Number(reportId)]);
    timings.updateMs = Date.now() - t;
    if (result.rows.length === 0) {
      const lockedError = new Error('This report is already finalized.');
      lockedError.code = 'REPORT_LOCKED';
      throw lockedError;
    }

    const payload = { ...report, status: result.rows[0].status };
    if (io?.emit) io.emit('pdiReportUpdate', { report_id: payload.report_id, status: payload.status });

    // The Drive backup and the on-disk copy for later downloads used to run
    // before the response -- uploading a ~20 MB PDF to Google (about 6 s
    // measured) while the phone waited for a PDF it already had. Both are
    // best-effort and need nothing from the client, so they run after the
    // response. `background` lets tests (and nothing else) wait for them.
    const background = Promise.all([
      this.#backupPdfToDrive(report, pdfBuffer),
      pdfCache.write(report.report_id, pdfBuffer),
    ]);

    timings.totalMs = Date.now() - started;
    return { payload, pdfBuffer, timings, background };
  }

  // Best-effort Drive backup — same reasoning as InvoiceRecords.create: a
  // "generated" report can always be regenerated from its stored data, so a
  // Drive outage shouldn't block finalizing. Never rejects.
  static async #backupPdfToDrive(report, pdfBuffer) {
    const reportId = report.report_id;
    const startedAt = Date.now();
    try {
      const safeNo = String(report.data?.pdi_no || reportId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `PDI_${safeNo}.pdf`);
      const res = await pool.query(
        'UPDATE pre_dispatch_inspection_reports SET drive_file_id = $1 WHERE report_id = $2',
        [uploaded.id, reportId]
      );
      if (res.rowCount === 0) {
        // The report was deleted while this was uploading -- deleteReport had
        // no drive_file_id to clean up yet, so the file would be orphaned.
        await deleteDriveFile(uploaded.id).catch((e) => logger.warn(`Drive cleanup failed for deleted PDI report ${reportId}: ${e.message}`));
        return;
      }
      logger.info(`PDI Drive backup: report ${reportId}, ${Date.now() - startedAt}ms, ${pdfBuffer.length} bytes`);
    } catch (e) {
      logger.warn(`Drive backup failed for PDI report ${reportId}: ${e.message}`);
    }
  }

  static async getPdfBuffer(reportId) {
    const report = await this.getById(reportId);
    return bufferPdf(await PDIGenerator.generate(report.template_id, report.template_version, { ...(report.data || {}), photos: report.photos || [] }));
  }

  // GET /pdf. A Completed report can't change, so its PDF is served from the
  // copy stored at finalize time when there is one; otherwise it is rendered
  // (and, if Completed, stored for next time). The report is loaded whole only
  // when it has to be rendered -- checking status and pdi_no needs neither the
  // photos nor the rest of `data`.
  static async getPdfForDownload(reportId) {
    const started = Date.now();
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const timings = {};

    const meta = await pool.query(
      `SELECT status, data->>'pdi_no' AS pdi_no FROM pre_dispatch_inspection_reports WHERE report_id = $1`,
      [_id]
    );
    if (meta.rows.length === 0) throw new Error('Report not found');
    const { status, pdi_no: pdiNo } = meta.rows[0];
    if (!pdiNo) {
      const missing = new Error('pdi_no required to generate a PDF');
      missing.code = 'PDI_NO_REQUIRED';
      throw missing;
    }

    if (status === 'Completed') {
      const cached = await pdfCache.read(_id);
      if (cached) {
        timings.totalMs = Date.now() - started;
        return { buffer: cached, pdiNo, source: 'cache', timings: { ...timings, pdfBytes: cached.length } };
      }
    }

    let t = Date.now();
    const report = await this.getById(_id);
    timings.loadMs = Date.now() - t;
    timings.photos = countPhotos(report.photos);

    t = Date.now();
    const generateTimings = {};
    const buffer = await bufferPdf(await PDIGenerator.generate(
      report.template_id, report.template_version,
      { ...(report.data || {}), photos: report.photos || [] },
      { timings: generateTimings },
    ));
    timings.renderMs = Date.now() - t;
    timings.optimize = generateTimings.optimize || null;
    timings.pdfBytes = buffer.length;

    if (report.status === 'Completed') await pdfCache.write(_id, buffer);
    timings.totalMs = Date.now() - started;
    return { buffer, pdiNo, source: 'rendered', timings };
  }

  static async deleteReport(reportId, io) {
    const _id = Number(reportId);
    if (!Number.isFinite(_id)) throw new Error('Report not found');
    const result = await pool.query(
      'DELETE FROM pre_dispatch_inspection_reports WHERE report_id = $1 RETURNING report_id, drive_file_id',
      [_id]
    );
    if (result.rows.length === 0) throw new Error('Report not found');

    await pdfCache.remove(_id);

    const driveFileId = result.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for PDI report ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    if (io?.emit) io.emit('pdiReportUpdate', { report_id: _id, status: 'Deleted' });
    return { report_id: _id };
  }

  // Used to guard authored-template deletion: a template with report history
  // can't be hard-deleted (its rows are still needed to re-render those reports).
  static async countByTemplateId(templateId) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM pre_dispatch_inspection_reports WHERE template_id = $1`,
      [templateId]
    );
    return result.rows[0].count;
  }
}

module.exports = PdiReports;
