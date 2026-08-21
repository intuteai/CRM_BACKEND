// models/hr/invoiceRecords.js
const pool = require('../../config/db');
const logger = require('../../utils/logger');
const Invoice = require('./invoice');
const { uploadBufferToDrivePrivate, deleteDriveFile } = require('../../services/googleDrive');

// Collects a PDFKit document's output into a single Buffer.
function bufferPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// Explicit column list (never `*`/`RETURNING *`) because invoice_date/order_date
// are DATE columns — node-postgres returns those as JS Date objects that get
// silently shifted by the server's UTC offset (IST here) when JSON-serialized
// via res.json()'s .toISOString() call. Same root cause as the created_at
// cursor bug elsewhere in this file. to_char() hands back a plain,
// timezone-neutral 'YYYY-MM-DD' string instead, sidestepping it entirely.
// `prefix` lets the same fragment serve both a bare INSERT...RETURNING (no
// alias) and an aliased JOIN-based SELECT (prefix 'i').
function invoiceColumns(prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  return `
    ${p}invoice_id, ${p}invoice_number, to_char(${p}invoice_date, 'YYYY-MM-DD') AS invoice_date,
    ${p}order_no, to_char(${p}order_date, 'YYYY-MM-DD') AS order_date,
    ${p}billing_name, ${p}billing_address, ${p}billing_phone, ${p}billing_email, ${p}billing_gst,
    ${p}hsn, ${p}vendor_code, ${p}gst_percent, ${p}items, ${p}total_amount, ${p}gst_amount, ${p}grand_total,
    ${p}created_by, ${p}source, ${p}drive_file_id, ${p}created_at, ${p}updated_at
  `;
}

class InvoiceRecords {
  static #toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  static #safeEmit(io, event, payload) { if (!io?.emit) return; try { io.emit(event, payload); } catch (e) { logger.warn('Socket emit failed:', e.message); } }
  static #emptyToNull(v) { const s = String(v ?? '').trim(); return s ? s : null; }

  static #computeTotals(items, gstPercent) {
    const totalAmount = items.reduce((sum, i) => sum + i.qty * i.rate, 0);
    const gstAmount = totalAmount * (gstPercent / 100);
    const grandTotal = Math.round((totalAmount + gstAmount) * 100) / 100;
    return { totalAmount, gstAmount, grandTotal };
  }

  static #validateAndNormalize(data) {
    if (!data?.invoiceNumber?.trim()) throw new Error('Invoice number is required');
    if (!data?.date) throw new Error('Invoice date is required');
    if (!data?.billing?.name?.trim()) throw new Error('Billing company/customer name is required');
    if (!Array.isArray(data.items) || data.items.length === 0) throw new Error('At least one invoice item is required');

    const items = data.items
      .map(i => ({
        description: String(i?.description || ''),
        qty: this.#toNumber(i?.qty),
        rate: this.#toNumber(i?.rate),
      }))
      .filter(i => i.description.trim() && i.qty > 0);
    if (items.length === 0) throw new Error('At least one invoice item with a description and qty is required');

    const gstPercent = Number.isFinite(Number(data.gstPercent)) ? Number(data.gstPercent) : 18;
    return { items, gstPercent };
  }

  static #toPayload(row) {
    return {
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      date: row.invoice_date,
      orderNo: row.order_no || '',
      orderDate: row.order_date || '',
      billing: {
        name: row.billing_name,
        address: row.billing_address || '',
        phone: row.billing_phone || '',
        email: row.billing_email || '',
        gst: row.billing_gst || '',
      },
      hsn: row.hsn || '',
      vendorCode: row.vendor_code || '',
      gstPercent: Number(row.gst_percent),
      items: row.items,
      totalAmount: Number(row.total_amount),
      gstAmount: Number(row.gst_amount),
      grandTotal: Number(row.grand_total),
      source: row.source || 'generated',
      driveFileId: row.drive_file_id || null,
      createdBy: row.created_by,
      createdByName: row.created_by_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ==================== CREATE (generated) ====================
  static async create(data, io) {
    const { items, gstPercent } = this.#validateAndNormalize(data);
    const { totalAmount, gstAmount, grandTotal } = this.#computeTotals(items, gstPercent);
    const createdById = io?.user?.user_id ?? null;

    // Best-effort Drive backup: if Drive is unreachable, still save the invoice
    // record — a "generated" invoice can always be regenerated on demand from
    // its stored data, so a Drive outage shouldn't block the user's work.
    let driveFileId = null;
    try {
      const pdfBuffer = await bufferPdf(Invoice.generate({ ...data, items, gstPercent }));
      const safeNumber = data.invoiceNumber.trim().replace(/[^a-zA-Z0-9]/g, '_');
      const uploaded = await uploadBufferToDrivePrivate(pdfBuffer, 'application/pdf', `INVOICE_${safeNumber}.pdf`);
      driveFileId = uploaded.id;
    } catch (e) {
      logger.warn(`Drive backup failed for invoice ${data.invoiceNumber}: ${e.message}`);
    }

    try {
      const res = await pool.query(`
        INSERT INTO invoices
          (invoice_number, invoice_date, order_no, order_date, billing_name, billing_address,
           billing_phone, billing_email, billing_gst, hsn, vendor_code, gst_percent, items,
           total_amount, gst_amount, grand_total, created_by, source, drive_file_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'generated', $18)
        RETURNING ${invoiceColumns()}
      `, [
        data.invoiceNumber.trim(), data.date, this.#emptyToNull(data.orderNo), this.#emptyToNull(data.orderDate),
        data.billing.name.trim(), this.#emptyToNull(data.billing.address), this.#emptyToNull(data.billing.phone),
        this.#emptyToNull(data.billing.email), this.#emptyToNull(data.billing.gst),
        this.#emptyToNull(data.hsn), this.#emptyToNull(data.vendorCode), gstPercent, JSON.stringify(items),
        totalAmount, gstAmount, grandTotal, createdById, driveFileId,
      ]);

      let created_by_name = null;
      if (createdById) {
        const userRes = await pool.query('SELECT name FROM users WHERE user_id = $1', [createdById]);
        created_by_name = userRes.rows[0]?.name || null;
      }

      const payload = this.#toPayload({ ...res.rows[0], created_by_name });
      this.#safeEmit(io, 'invoice_records:created', payload);
      return payload;
    } catch (err) {
      // The Drive upload above already succeeded — if the DB insert now fails
      // (e.g. duplicate invoice number), that file would otherwise become a
      // permanent orphan with no DB row ever pointing back to it.
      if (driveFileId) {
        try { await deleteDriveFile(driveFileId); }
        catch (cleanupErr) { logger.warn(`Orphan Drive cleanup failed for ${driveFileId}: ${cleanupErr.message}`); }
      }
      if (err.code === '23505' && err.constraint?.includes('invoice_number')) {
        throw new Error(`Invoice number "${data.invoiceNumber}" already exists`);
      }
      throw err;
    }
  }

  // ==================== CREATE (uploaded old invoice) ====================
  static async createUploaded({ invoiceNumber, date, customerName, grandTotal }, fileBuffer, io) {
    if (!invoiceNumber?.trim()) throw new Error('Invoice number is required');
    if (!date) throw new Error('Invoice date is required');
    if (!customerName?.trim()) throw new Error('Customer name is required');
    const total = this.#toNumber(grandTotal);
    if (!(total > 0)) throw new Error('Total amount must be greater than 0');
    if (!fileBuffer || fileBuffer.length === 0) throw new Error('A PDF file is required');
    if (fileBuffer.slice(0, 5).toString('ascii') !== '%PDF-') throw new Error('Uploaded file is not a valid PDF');

    const createdById = io?.user?.user_id ?? null;

    // Unlike the generated flow, there's no way to regenerate an uploaded
    // invoice from structured data — Drive is the only copy, so a failed
    // upload here must fail the whole request rather than degrade silently.
    const safeNumber = invoiceNumber.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const uploaded = await uploadBufferToDrivePrivate(fileBuffer, 'application/pdf', `INVOICE_${safeNumber}.pdf`);

    try {
      const res = await pool.query(`
        INSERT INTO invoices
          (invoice_number, invoice_date, billing_name, gst_percent, items,
           total_amount, gst_amount, grand_total, created_by, source, drive_file_id)
        VALUES ($1, $2, $3, 0, '[]'::jsonb, $4, 0, $4, $5, 'uploaded', $6)
        RETURNING ${invoiceColumns()}
      `, [invoiceNumber.trim(), date, customerName.trim(), total, createdById, uploaded.id]);

      let created_by_name = null;
      if (createdById) {
        const userRes = await pool.query('SELECT name FROM users WHERE user_id = $1', [createdById]);
        created_by_name = userRes.rows[0]?.name || null;
      }

      const payload = this.#toPayload({ ...res.rows[0], created_by_name });
      this.#safeEmit(io, 'invoice_records:created', payload);
      return payload;
    } catch (err) {
      // Same orphan-cleanup concern as the generated flow above.
      try { await deleteDriveFile(uploaded.id); }
      catch (cleanupErr) { logger.warn(`Orphan Drive cleanup failed for ${uploaded.id}: ${cleanupErr.message}`); }
      if (err.code === '23505' && err.constraint?.includes('invoice_number')) {
        throw new Error(`Invoice number "${invoiceNumber}" already exists`);
      }
      throw err;
    }
  }

  // ==================== GET ALL ====================
  static async getAll({ limit = 20, cursor = null, search = '' } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 20, 1), 100);

    let cursorId = null;
    let cursorCreatedAt = null;
    if (cursor) {
      try {
        // Split on the FIRST colon only — an ISO timestamp (2026-08-20T01:23:45.678Z)
        // contains colons itself, so a naive cursor.split(':') truncates it.
        const sepIdx = cursor.indexOf(':');
        cursorId = parseInt(cursor.slice(0, sepIdx), 10);
        cursorCreatedAt = cursor.slice(sepIdx + 1);
      } catch {}
    }

    const searchTerm = search?.trim() ? `%${search.trim()}%` : null;

    // Cursor compares against created_at as a formatted TEXT string, not a
    // timestamp cast. "timestamp without time zone" here stores server-local
    // (IST) wall-clock values; round-tripping through a JS Date's
    // .toISOString() (which asserts UTC) and casting that string back via
    // ::timestamp made Postgres shift it by the server's UTC offset,
    // silently corrupting every cursor. A plain zero-padded text compare
    // sidesteps timezone interpretation entirely.
    const query = `
      SELECT ${invoiceColumns('i')}, u.name AS created_by_name,
        to_char(i.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS created_at_cursor
      FROM invoices i
      LEFT JOIN users u ON i.created_by = u.user_id
      WHERE (
        $1::text IS NULL
        OR to_char(i.created_at, 'YYYY-MM-DD HH24:MI:SS.US') < $1::text
        OR (to_char(i.created_at, 'YYYY-MM-DD HH24:MI:SS.US') = $1::text AND i.invoice_id < $2)
      )
      AND (
        $4::text IS NULL
        OR i.invoice_number ILIKE $4
        OR i.billing_name ILIKE $4
      )
      ORDER BY i.created_at DESC, i.invoice_id DESC
      LIMIT $3
    `;

    const countQuery = `
      SELECT COUNT(*)::int FROM invoices i
      WHERE ($1::text IS NULL OR i.invoice_number ILIKE $1 OR i.billing_name ILIKE $1)
    `;

    const [result, totalRes] = await Promise.all([
      pool.query(query, [cursorCreatedAt, cursorId, _limit, searchTerm]),
      pool.query(countQuery, [searchTerm]),
    ]);

    const data = result.rows.map(row => this.#toPayload(row));
    const nextCursor = data.length === _limit && data.length > 0
      ? `${result.rows[data.length - 1].invoice_id}:${result.rows[data.length - 1].created_at_cursor}`
      : null;

    return { data, total: totalRes.rows[0].count, cursor: nextCursor };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const _id = Number(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid invoice id');

    const res = await pool.query(`
      SELECT ${invoiceColumns('i')}, u.name AS created_by_name
      FROM invoices i
      LEFT JOIN users u ON i.created_by = u.user_id
      WHERE i.invoice_id = $1
    `, [_id]);

    if (res.rows.length === 0) throw new Error('Invoice not found');
    return this.#toPayload(res.rows[0]);
  }

  // ==================== DELETE ====================
  static async delete(id, io) {
    const _id = Number(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid invoice id');

    const res = await pool.query('DELETE FROM invoices WHERE invoice_id = $1 RETURNING invoice_id, drive_file_id', [_id]);
    if (res.rows.length === 0) throw new Error('Invoice not found');

    const driveFileId = res.rows[0].drive_file_id;
    if (driveFileId) {
      try { await deleteDriveFile(driveFileId); }
      catch (e) { logger.warn(`Drive cleanup failed for invoice ${_id} (file ${driveFileId}): ${e.message}`); }
    }

    const payload = { invoiceId: res.rows[0].invoice_id };
    this.#safeEmit(io, 'invoice_records:deleted', payload);
    return payload;
  }
}

module.exports = InvoiceRecords;
