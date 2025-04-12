const pool = require('../config/db');

class PurchaseInvoice {
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT pi.invoice_id AS "invoiceId", pi.sr_no AS "srNo", pi.supplier_code AS "supplierCode",
             pi.supplier_name AS "supplierName", pi.invoice_number AS "invoiceNumber",
             pi.issue_date AS "issueDate", pi.description, pi.unit_price AS "unitPrice",
             pi.quantity, pi.link_pdf AS "linkPdf", pi.product_id AS "productId",
             pi.created_at AS "createdAt", pi.updated_at AS "updatedAt"
      FROM purchase_invoices pi
      ORDER BY pi.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [limit, offset]);
    return rows;
  }

  static async create({
    supplierCode,
    supplierName,
    invoiceNumber,
    issueDate,
    description,
    unitPrice,
    quantity,
    linkPdf,
    productId
  }) {
    const query = `
      INSERT INTO purchase_invoices (
        supplier_code, supplier_name, invoice_number, issue_date,
        description, unit_price, quantity, link_pdf, product_id,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING invoice_id AS "invoiceId", sr_no AS "srNo", supplier_code AS "supplierCode",
                supplier_name AS "supplierName", invoice_number AS "invoiceNumber",
                issue_date AS "issueDate", description, unit_price AS "unitPrice",
                quantity, link_pdf AS "linkPdf", product_id AS "productId",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const values = [
      supplierCode,
      supplierName,
      invoiceNumber,
      issueDate,
      description,
      unitPrice,
      quantity,
      linkPdf || null,
      productId
    ];
    const { rows } = await pool.query(query, values);
    return rows[0];
  }

  static async update(invoiceId, {
    supplierCode,
    supplierName,
    invoiceNumber,
    issueDate,
    description,
    unitPrice,
    quantity,
    linkPdf,
    productId
  }) {
    const query = `
      UPDATE purchase_invoices
      SET supplier_code = $1, supplier_name = $2, invoice_number = $3,
          issue_date = $4, description = $5, unit_price = $6,
          quantity = $7, link_pdf = $8, product_id = $9,
          updated_at = CURRENT_TIMESTAMP
      WHERE invoice_id = $10
      RETURNING invoice_id AS "invoiceId", sr_no AS "srNo", supplier_code AS "supplierCode",
                supplier_name AS "supplierName", invoice_number AS "invoiceNumber",
                issue_date AS "issueDate", description, unit_price AS "unitPrice",
                quantity, link_pdf AS "linkPdf", product_id AS "productId",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const values = [
      supplierCode,
      supplierName,
      invoiceNumber,
      issueDate,
      description,
      unitPrice,
      quantity,
      linkPdf || null,
      productId,
      invoiceId
    ];
    const { rows } = await pool.query(query, values);
    if (rows.length === 0) {
      throw new Error('Purchase invoice not found');
    }
    return rows[0];
  }

  static async delete(invoiceId) {
    const query = `
      DELETE FROM purchase_invoices
      WHERE invoice_id = $1
      RETURNING invoice_id AS "invoiceId", product_id AS "productId", quantity
    `;
    const { rows } = await pool.query(query, [invoiceId]);
    if (rows.length === 0) {
      throw new Error('Purchase invoice not found');
    }
    return rows[0];
  }
}

module.exports = PurchaseInvoice;