// models/parts.js
const pool = require('../config/db');
const logger = require('../utils/logger');

class Parts {
  // --------------------------------------------------------------
  // 1. GET ALL PARTS (with type info)
  // --------------------------------------------------------------
  static async getAll({ limit = 10, offset = 0 }) {
    const listQuery = `
      SELECT 
        p.id                AS "id",
        p.part_code         AS "partCode",
        p.part_type_id      AS "partTypeId",
        pt.type_name        AS "partTypeName",
        pt.prefix           AS "partPrefix",
        p.name              AS "name",
        p.description       AS "description",
        p.drawing_no        AS "drawingNo",
        p.customer_part_no  AS "customerPartNo",
        p.supplier_part_no  AS "supplierPartNo",
        p.created_at        AS "createdAt",
        p.updated_at        AS "updatedAt"
      FROM parts p
      JOIN part_types pt ON p.part_type_id = pt.id
      ORDER BY p.id ASC
      LIMIT $1 OFFSET $2
    `;

    const countQuery = 'SELECT COUNT(*) FROM parts';

    try {
      const [listResult, countResult] = await Promise.all([
        pool.query(listQuery, [limit, offset]),
        pool.query(countQuery),
      ]);

      return {
        data: listResult.rows,
        total: parseInt(countResult.rows[0].count, 10),
      };
    } catch (error) {
      logger.error('Error fetching parts:', error.stack || error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 2. GET ALL PART TYPES
  // --------------------------------------------------------------
  static async getPartTypes() {
    const query = `
      SELECT 
        id,
        type_name AS "typeName",
        prefix
      FROM part_types
      ORDER BY type_name ASC
    `;

    try {
      const { rows } = await pool.query(query);
      return rows;
    } catch (error) {
      logger.error('Error fetching part types:', error.stack || error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 3. PREVIEW NEXT CODE (NO DB UPDATE)
  //     Used only for showing a preview in UI
  // --------------------------------------------------------------
  static async previewNextCode(partTypeId) {
    const typeQuery = `
      SELECT 
        id,
        prefix
      FROM part_types
      WHERE id = $1
    `;

    const serialQuery = `
      SELECT last_serial
      FROM part_serials
      WHERE part_type_id = $1
    `;

    try {
      const { rows: typeRows } = await pool.query(typeQuery, [partTypeId]);
      if (typeRows.length === 0) {
        const error = new Error('Invalid part type');
        error.code = 'INVALID_PART_TYPE';
        throw error;
      }

      const { prefix } = typeRows[0];

      const { rows: serialRows } = await pool.query(serialQuery, [partTypeId]);
      const lastSerial = serialRows.length ? Number(serialRows[0].last_serial) : 0;
      const nextSerial = lastSerial + 1;

      const padded = String(nextSerial).padStart(7, '0');
      const partCode = `${prefix}${padded}`;

      return {
        partCode,
        prefix,
        nextSerial,
      };
    } catch (error) {
      logger.error('Error previewing next part code:', error.stack || error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 4. CREATE PART (atomic code generation)
  // --------------------------------------------------------------
  static async create({
    partTypeId,
    name,
    description,
    drawingNo,
    customerPartNo,
    supplierPartNo,
  }) {
    try {
      await pool.query('BEGIN');

      // 1) Ensure valid part type & get prefix
      const typeQuery = `
        SELECT id, prefix
        FROM part_types
        WHERE id = $1
        FOR UPDATE
      `;
      const { rows: typeRows } = await pool.query(typeQuery, [partTypeId]);

      if (typeRows.length === 0) {
        throw new Error('Invalid part type');
      }

      const { prefix } = typeRows[0];

      // 2) Lock / insert serial row
      const serialSelectQuery = `
        SELECT last_serial
        FROM part_serials
        WHERE part_type_id = $1
        FOR UPDATE
      `;
      let { rows: serialRows } = await pool.query(serialSelectQuery, [partTypeId]);

      let lastSerial;
      if (serialRows.length === 0) {
        // No row yet → create one with last_serial = 0
        const serialInsertQuery = `
          INSERT INTO part_serials (part_type_id, last_serial)
          VALUES ($1, 0)
          RETURNING last_serial
        `;
        const insertRes = await pool.query(serialInsertQuery, [partTypeId]);
        lastSerial = Number(insertRes.rows[0].last_serial);
      } else {
        lastSerial = Number(serialRows[0].last_serial);
      }

      // 3) Compute next serial and full code
      const newSerial = lastSerial + 1;
      const padded = String(newSerial).padStart(7, '0');
      const partCode = `${prefix}${padded}`;

      // 4) Update last_serial
      const serialUpdateQuery = `
        UPDATE part_serials
        SET last_serial = $1
        WHERE part_type_id = $2
      `;
      await pool.query(serialUpdateQuery, [newSerial, partTypeId]);

      // 5) Insert part
      const insertQuery = `
        INSERT INTO parts (
          part_code,
          part_type_id,
          name,
          description,
          drawing_no,
          customer_part_no,
          supplier_part_no,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING
          id               AS "id",
          part_code        AS "partCode",
          part_type_id     AS "partTypeId",
          name             AS "name",
          description      AS "description",
          drawing_no       AS "drawingNo",
          customer_part_no AS "customerPartNo",
          supplier_part_no AS "supplierPartNo",
          created_at       AS "createdAt",
          updated_at       AS "updatedAt"
      `;

      const values = [
        partCode,
        partTypeId,
        name,
        description,
        drawingNo,
        customerPartNo || null,
        supplierPartNo || null,
      ];

      const { rows: partRows } = await pool.query(insertQuery, values);

      await pool.query('COMMIT');

      return {
        ...partRows[0],
        partCode, // ensure included
      };
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error('Error creating part:', error.stack || error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 5. UPDATE PART (no change to part_code or part_type_id)
  // --------------------------------------------------------------
  static async update(id, {
    name,
    description,
    drawingNo,
    customerPartNo,
    supplierPartNo,
  }) {
    const query = `
      UPDATE parts
      SET
        name             = $1,
        description      = $2,
        drawing_no       = $3,
        customer_part_no = $4,
        supplier_part_no = $5,
        updated_at       = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING
        id               AS "id",
        part_code        AS "partCode",
        part_type_id     AS "partTypeId",
        name             AS "name",
        description      AS "description",
        drawing_no       AS "drawingNo",
        customer_part_no AS "customerPartNo",
        supplier_part_no AS "supplierPartNo",
        created_at       AS "createdAt",
        updated_at       AS "updatedAt"
    `;

    const values = [
      name,
      description,
      drawingNo,
      customerPartNo || null,
      supplierPartNo || null,
      id,
    ];

    try {
      const { rows } = await pool.query(query, values);
      if (rows.length === 0) {
        const err = new Error('Part not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return rows[0];
    } catch (error) {
      logger.error(`Error updating part ${id}:`, error.stack || error);
      throw error;
    }
  }

  // --------------------------------------------------------------
  // 6. DELETE PART (hard delete for now)
  // --------------------------------------------------------------
  static async delete(id) {
    const query = `
      DELETE FROM parts
      WHERE id = $1
      RETURNING id AS "id"
    `;

    try {
      const { rows } = await pool.query(query, [id]);
      if (rows.length === 0) {
        const err = new Error('Part not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      return rows[0];
    } catch (error) {
      logger.error(`Error deleting part ${id}:`, error.stack || error);
      throw error;
    }
  }
}

module.exports = Parts;
