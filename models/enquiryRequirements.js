// models/enquiryRequirements.js
// Inspired by your models/stock.js style. Uses a `pool` (pg) instance from ../config/db
// Tables used:
//  - enquiry_requirements
//  - enquiry_requirement_motors

const pool = require('../config/db');

class EnquiryRequirements {
  // --------------------------------------------------------------
  // 1. LIST / PAGINATE (with optional filters)
  // returns enquiry requirement rows (no motors) with total count
  // --------------------------------------------------------------
  static async getAll({ limit = 10, offset = 0, enquiryId, status, priority, assigneeId } = {}) {
    const whereClauses = [];
    const values = [];
    let idx = 1;

    if (enquiryId !== undefined) {
      whereClauses.push(`enquiry_id = $${idx++}`);
      values.push(enquiryId);
    }
    if (status !== undefined) {
      whereClauses.push(`status = $${idx++}`);
      values.push(status);
    }
    if (priority !== undefined) {
      whereClauses.push(`priority = $${idx++}`);
      values.push(priority);
    }
    if (assigneeId !== undefined) {
      whereClauses.push(`assignee_id = $${idx++}`);
      values.push(assigneeId);
    }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT
        id                           AS "id",
        enquiry_id                   AS "enquiryId",
        title                        AS "title",
        description                  AS "description",
        requirement_type             AS "requirementType",
        priority                     AS "priority",
        status                       AS "status",
        assignee_id                  AS "assigneeId",
        due_date                     AS "dueDate",
        attachments                  AS "attachments",
        metadata                     AS "metadata",
        created_by                   AS "createdBy",
        updated_by                   AS "updatedBy",
        created_at                   AS "createdAt",
        updated_at                   AS "updatedAt"
      FROM enquiry_requirements
      ${whereSQL}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    values.push(limit, offset);

    const totalQuery = `
      SELECT COUNT(*)::int AS total
      FROM enquiry_requirements
      ${whereSQL}
    `;

    try {
      const [rowsRes, totalRes] = await Promise.all([
        pool.query(query, values),
        pool.query(totalQuery, values.slice(0, values.length - 2)) // same where params
      ]);

      return {
        data: rowsRes.rows,
        total: totalRes.rows[0]?.total ?? 0
      };
    } catch (err) {
      console.error('Error fetching enquiry requirements:', err);
      throw err;
    }
  }

  // --------------------------------------------------------------
  // 2. GET BY ID (includes optional motors)
  // --------------------------------------------------------------
  static async getById(id, { includeMotors = false } = {}) {
    const q = `
      SELECT
        id                           AS "id",
        enquiry_id                   AS "enquiryId",
        title                        AS "title",
        description                  AS "description",
        requirement_type             AS "requirementType",
        priority                     AS "priority",
        status                       AS "status",
        assignee_id                  AS "assigneeId",
        due_date                     AS "dueDate",
        attachments                  AS "attachments",
        metadata                     AS "metadata",
        created_by                   AS "createdBy",
        updated_by                   AS "updatedBy",
        created_at                   AS "createdAt",
        updated_at                   AS "updatedAt"
      FROM enquiry_requirements
      WHERE id = $1
      LIMIT 1
    `;
    try {
      const { rows } = await pool.query(q, [id]);
      if (rows.length === 0) return null;
      const item = rows[0];

      if (includeMotors) {
        const motors = await this.listMotors(id);
        item.motors = motors;
      }

      return item;
    } catch (err) {
      console.error(`Error getting enquiry requirement ${id}:`, err);
      throw err;
    }
  }

  // --------------------------------------------------------------
  // 3. CREATE (optionally create motors in the same transaction)
  // motors: array of motor objects (see insert logic below)
  // --------------------------------------------------------------
  static async create(payload = {}) {
    const {
      enquiryId,
      title,
      description = null,
      requirementType = null,
      priority = 'medium',
      status = 'open',
      assigneeId = null,
      dueDate = null,
      attachments = [],
      metadata = {},
      createdBy = null,
      motors = [] // optional array of motor specs to insert
    } = payload;

    const insertReqQuery = `
      INSERT INTO enquiry_requirements (
        enquiry_id, title, description, requirement_type, priority,
        status, assignee_id, due_date, attachments, metadata, created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)
      RETURNING
        id, enquiry_id AS "enquiryId", title, description, requirement_type AS "requirementType",
        priority, status, assignee_id AS "assigneeId", due_date AS "dueDate",
        attachments, metadata, created_by AS "createdBy", created_at AS "createdAt"
    `;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(insertReqQuery, [
        enquiryId,
        title,
        description,
        requirementType,
        priority,
        status,
        assigneeId,
        dueDate,
        attachments,
        metadata,
        createdBy
      ]);

      const reqRow = rows[0];

      // insert motors if provided
      if (Array.isArray(motors) && motors.length) {
        const motorInsertQuery = `
          INSERT INTO enquiry_requirement_motors (
            requirement_id, application, power_rating, motor_voltage,
            motor_rpm, motor_max_rpm, motor_type, em_brake, em_brake_voltage,
            shaft_type, gvw, controller, controller_text, created_at
          ) VALUES
        `;

        // build parameterized values
        const params = [];
        const valueBlocks = motors.map((m, i) => {
          const base = i * 13;
          params.push(
            reqRow.id,
            m.application || null,
            m.power_rating || null,
            m.motor_voltage || null,
            m.motor_rpm ?? null,
            m.motor_max_rpm ?? null,
            m.motor_type || null,
            m.em_brake === true,
            m.em_brake_voltage || null,
            m.shaft_type || null,
            m.gvw || null,
            m.controller || null,
            m.controller_text || null
          );
          const placeholders = Array.from({ length: 13 }, (_, j) => `$${base + j + 1}`).join(',');
          return `(${placeholders})`;
        });

        const finalMotorQuery = motorInsertQuery + valueBlocks.join(',') + ' RETURNING id';
        await client.query(finalMotorQuery, params);
      }

      await client.query('COMMIT');
      return reqRow;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error creating enquiry requirement:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------------
  // 4. UPDATE (optionally replace motors if motors array provided)
  // If motors array is provided we delete existing motors for the requirement
  // and insert the provided list. This keeps logic simple.
  // --------------------------------------------------------------
  static async update(id, patch = {}) {
    const {
      title,
      description,
      requirementType,
      priority,
      status,
      assigneeId,
      dueDate,
      attachments,
      metadata,
      updatedBy = null,
      motors // optional: array to replace existing motors
    } = patch;

    // build dynamic SET clauses
    const sets = [];
    const values = [];
    let idx = 1;

    if (title !== undefined) {
      sets.push(`title = $${idx++}`);
      values.push(title);
    }
    if (description !== undefined) {
      sets.push(`description = $${idx++}`);
      values.push(description);
    }
    if (requirementType !== undefined) {
      sets.push(`requirement_type = $${idx++}`);
      values.push(requirementType);
    }
    if (priority !== undefined) {
      sets.push(`priority = $${idx++}`);
      values.push(priority);
    }
    if (status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(status);
    }
    if (assigneeId !== undefined) {
      sets.push(`assignee_id = $${idx++}`);
      values.push(assigneeId);
    }
    if (dueDate !== undefined) {
      sets.push(`due_date = $${idx++}`);
      values.push(dueDate);
    }
    if (attachments !== undefined) {
      sets.push(`attachments = $${idx++}`);
      values.push(attachments);
    }
    if (metadata !== undefined) {
      sets.push(`metadata = $${idx++}`);
      values.push(metadata);
    }
    // always set updated_by and updated_at if provided or not
    sets.push(`updated_by = $${idx++}`);
    values.push(updatedBy);
    sets.push(`updated_at = CURRENT_TIMESTAMP`);

    if (sets.length === 0) {
      throw new Error('Nothing to update');
    }

    const updateQuery = `
      UPDATE enquiry_requirements
      SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING
        id, enquiry_id AS "enquiryId", title, description, requirement_type AS "requirementType",
        priority, status, assignee_id AS "assigneeId", due_date AS "dueDate",
        attachments, metadata, updated_by AS "updatedBy", updated_at AS "updatedAt"
    `;

    values.push(id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(updateQuery, values);
      if (rows.length === 0) {
        throw new Error('Enquiry requirement not found');
      }
      const updated = rows[0];

      // if motors provided, replace existing motors (simple approach)
      if (Array.isArray(motors)) {
        await client.query('DELETE FROM enquiry_requirement_motors WHERE requirement_id = $1', [id]);

        if (motors.length) {
          const motorInsertBase = `
            INSERT INTO enquiry_requirement_motors (
              requirement_id, application, power_rating, motor_voltage,
              motor_rpm, motor_max_rpm, motor_type, em_brake, em_brake_voltage,
              shaft_type, gvw, controller, controller_text, created_at
            ) VALUES
          `;
          const params = [];
          const blocks = motors.map((m, i) => {
            const base = i * 13;
            params.push(
              id,
              m.application || null,
              m.power_rating || null,
              m.motor_voltage || null,
              m.motor_rpm ?? null,
              m.motor_max_rpm ?? null,
              m.motor_type || null,
              m.em_brake === true,
              m.em_brake_voltage || null,
              m.shaft_type || null,
              m.gvw || null,
              m.controller || null,
              m.controller_text || null
            );
            const placeholders = Array.from({ length: 13 }, (_, j) => `$${base + j + 1}`).join(',');
            return `(${placeholders})`;
          });

          const finalMotorQuery = motorInsertBase + blocks.join(',') + ' RETURNING id';
          await client.query(finalMotorQuery, params);
        }
      }

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Error updating enquiry requirement ${id}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  // --------------------------------------------------------------
  // 5. DELETE
  // --------------------------------------------------------------
  static async delete(id) {
    const query = `
      DELETE FROM enquiry_requirements
      WHERE id = $1
      RETURNING id
    `;
    try {
      const { rows } = await pool.query(query, [id]);
      if (rows.length === 0) throw new Error('Enquiry requirement not found');
      return { id: rows[0].id };
    } catch (err) {
      console.error(`Error deleting enquiry requirement ${id}:`, err);
      throw err;
    }
  }

  // --------------------------------------------------------------
  // 6. MOTORS: list, add, update, delete (granular motor ops)
  // --------------------------------------------------------------
  static async listMotors(requirementId) {
    const q = `
      SELECT
        id,
        requirement_id AS "requirementId",
        application,
        power_rating,
        motor_voltage,
        motor_rpm,
        motor_max_rpm,
        motor_type,
        em_brake,
        em_brake_voltage,
        shaft_type,
        gvw,
        controller,
        controller_text,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM enquiry_requirement_motors
      WHERE requirement_id = $1
      ORDER BY id ASC
    `;
    try {
      const { rows } = await pool.query(q, [requirementId]);
      return rows;
    } catch (err) {
      console.error(`Error listing motors for requirement ${requirementId}:`, err);
      throw err;
    }
  }

  static async addMotor(requirementId, m = {}) {
    const q = `
      INSERT INTO enquiry_requirement_motors (
        requirement_id, application, power_rating, motor_voltage,
        motor_rpm, motor_max_rpm, motor_type, em_brake, em_brake_voltage,
        shaft_type, gvw, controller, controller_text, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP)
      RETURNING id, requirement_id AS "requirementId"
    `;
    const values = [
      requirementId,
      m.application || null,
      m.power_rating || null,
      m.motor_voltage || null,
      m.motor_rpm ?? null,
      m.motor_max_rpm ?? null,
      m.motor_type || null,
      m.em_brake === true,
      m.em_brake_voltage || null,
      m.shaft_type || null,
      m.gvw || null,
      m.controller || null,
      m.controller_text || null
    ];
    try {
      const { rows } = await pool.query(q, values);
      return rows[0];
    } catch (err) {
      console.error('Error adding motor:', err);
      throw err;
    }
  }

  static async updateMotor(motorId, m = {}) {
    const sets = [];
    const vals = [];
    let idx = 1;

    const pushIf = (field, col) => {
      if (m[field] !== undefined) {
        sets.push(`${col} = $${idx++}`);
        vals.push(m[field]);
      }
    };

    pushIf('application', 'application');
    pushIf('power_rating', 'power_rating');
    pushIf('motor_voltage', 'motor_voltage');
    pushIf('motor_rpm', 'motor_rpm');
    pushIf('motor_max_rpm', 'motor_max_rpm');
    pushIf('motor_type', 'motor_type');
    if (m.em_brake !== undefined) { sets.push(`em_brake = $${idx++}`); vals.push(m.em_brake === true); }
    pushIf('em_brake_voltage', 'em_brake_voltage');
    pushIf('shaft_type', 'shaft_type');
    pushIf('gvw', 'gvw');
    pushIf('controller', 'controller');
    pushIf('controller_text', 'controller_text');

    sets.push(`updated_at = CURRENT_TIMESTAMP`);

    if (sets.length === 0) throw new Error('Nothing to update for motor');

    const q = `
      UPDATE enquiry_requirement_motors
      SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING id, requirement_id AS "requirementId"
    `;
    vals.push(motorId);

    try {
      const { rows } = await pool.query(q, vals);
      if (rows.length === 0) throw new Error('Motor not found');
      return rows[0];
    } catch (err) {
      console.error(`Error updating motor ${motorId}:`, err);
      throw err;
    }
  }

  static async deleteMotor(motorId) {
    const q = `
      DELETE FROM enquiry_requirement_motors
      WHERE id = $1
      RETURNING id
    `;
    try {
      const { rows } = await pool.query(q, [motorId]);
      if (rows.length === 0) throw new Error('Motor not found');
      return { id: rows[0].id };
    } catch (err) {
      console.error(`Error deleting motor ${motorId}:`, err);
      throw err;
    }
  }
}

module.exports = EnquiryRequirements;
