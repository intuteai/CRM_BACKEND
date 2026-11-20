require('dotenv').config();
const pool = require('../../config/db');

// Raw-material stock history + purchase-invoice stock fix.
//
// 1. stock_adjustments: the API (models/core/stock.js) has always written here,
//    but the table was never created, so POST /api/stock/:id/adjust failed with
//    a 500. Until this runs, stock changes still work; they just are not logged
//    (the model skips the audit row when the table is missing).
//    product_id has no foreign key on purpose: history survives a delete.
//
// 2. update_raw_materials_stock(): the purchase_invoices trigger added
//    (NEW.quantity - OLD.quantity) to NEW.product_id only. Moving an invoice to a
//    different material left the old material's stock too high and gave the new
//    one only the difference. It now takes OLD off the old material and adds NEW
//    to the new one, and logs every change in stock_adjustments.
//
// Safe to run more than once. Run: node scripts/migrations/2026-11-20-raw-material-stock-adjustments.js
async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS stock_adjustments (
       adjustment_id SERIAL PRIMARY KEY,
       product_id    INTEGER NOT NULL,
       quantity      NUMERIC(10,2) NOT NULL,
       balance_after NUMERIC(10,2),
       reason        TEXT,
       source        VARCHAR(30) NOT NULL DEFAULT 'adjust',
       created_by    INTEGER,
       created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_stock_adjustments_product_created
       ON stock_adjustments (product_id, created_at DESC)`,
    `CREATE OR REPLACE FUNCTION update_raw_materials_stock() RETURNS trigger AS $$
     DECLARE
       old_qty NUMERIC := 0;
       new_qty NUMERIC := 0;
       bal NUMERIC;
     BEGIN
       IF TG_OP IN ('UPDATE', 'DELETE') THEN old_qty := COALESCE(OLD.quantity, 0); END IF;
       IF TG_OP IN ('INSERT', 'UPDATE') THEN new_qty := COALESCE(NEW.quantity, 0); END IF;

       IF TG_OP = 'UPDATE' AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id THEN
         IF NEW.product_id IS NOT NULL AND new_qty <> old_qty THEN
           UPDATE raw_materials SET stock_quantity = stock_quantity + (new_qty - old_qty)
             WHERE product_id = NEW.product_id RETURNING stock_quantity INTO bal;
           IF FOUND THEN
             INSERT INTO stock_adjustments (product_id, quantity, balance_after, reason, source)
             VALUES (NEW.product_id, new_qty - old_qty, bal,
                     'Purchase invoice ' || COALESCE(NEW.invoice_number, '#' || NEW.invoice_id::text) || ' edited',
                     'purchase_invoice');
           END IF;
         END IF;
         RETURN NULL;
       END IF;

       -- Take the old quantity off the old material (UPDATE to another material, or DELETE).
       IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.product_id IS NOT NULL AND old_qty <> 0 THEN
         UPDATE raw_materials SET stock_quantity = stock_quantity - old_qty
           WHERE product_id = OLD.product_id RETURNING stock_quantity INTO bal;
         IF FOUND THEN
           INSERT INTO stock_adjustments (product_id, quantity, balance_after, reason, source)
           VALUES (OLD.product_id, -old_qty, bal,
                   'Purchase invoice ' || COALESCE(OLD.invoice_number, '#' || OLD.invoice_id::text)
                     || CASE WHEN TG_OP = 'DELETE' THEN ' deleted' ELSE ' moved to another material' END,
                   'purchase_invoice');
         END IF;
       END IF;

       -- Add the new quantity to the new material (INSERT, or UPDATE to another material).
       IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.product_id IS NOT NULL AND new_qty <> 0 THEN
         UPDATE raw_materials SET stock_quantity = stock_quantity + new_qty
           WHERE product_id = NEW.product_id RETURNING stock_quantity INTO bal;
         IF FOUND THEN
           INSERT INTO stock_adjustments (product_id, quantity, balance_after, reason, source)
           VALUES (NEW.product_id, new_qty, bal,
                   'Purchase invoice ' || COALESCE(NEW.invoice_number, '#' || NEW.invoice_id::text),
                   'purchase_invoice');
         END IF;
       END IF;

       RETURN NULL;
     END;
     $$ LANGUAGE plpgsql`,
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) {
      console.log('Running:', sql.split('\n')[0].trim(), '...');
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
