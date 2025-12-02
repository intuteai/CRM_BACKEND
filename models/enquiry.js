// models/enquiry.js
const pool = require('../config/db');
const logger = require('../utils/logger');

const VALID_STATUSES = ['Pending', 'In Progress', 'Closed', 'Cancelled'];

// New: allowed lead values
const VALID_LEADS = ['hotlead', 'followup', 'lead', 'not_interested', 'closed'];

function normalizeStatus(input, { assigned = false } = {}) {
  if (input && VALID_STATUSES.includes(input)) return input;
  // Default logic:
  // - if assigned → "In Progress"
  // - else       → "Pending"
  return assigned ? 'In Progress' : 'Pending';
}

function normalizeLead(raw) {
  if (!raw) return 'lead';
  const lower = String(raw).toLowerCase();
  return VALID_LEADS.includes(lower) ? lower : 'lead';
}

class Enquiry {
  // =================================================================
  // CREATE NEW ENQUIRY (includes old columns: status, last_discussion, next_interaction)
  // =================================================================
  static async create(data, io, user) {
    const {
      enquiry_id,
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      source = 'Website',

      // NEW: lead replaces priority in DB
      // we accept both for backward compatibility
      lead,
      priority,

      tags = [],
      assigned_to = null, // optional: assign immediately
      due_date = null,

      // OLD COLUMNS – kept for compatibility
      status = 'Pending',
      last_discussion = null,
      next_interaction = null,
    } = data;

    if (!company_name?.trim()) throw new Error('Company name is required');

    // Normalize lead value (fallback to "priority" if old frontend still sends it)
    const finalLead = normalizeLead(lead || priority || 'lead');

    // Generate enquiry_id if not provided
    let finalEnquiryId = enquiry_id;
    if (!finalEnquiryId) {
      const year = new Date().getFullYear();
      for (let i = 0; i < 20; i++) {
        finalEnquiryId = `ENQ${year}${String(Math.floor(1000 + Math.random() * 9000))}`;
        const exists = await pool.query(
          'SELECT 1 FROM enquiries WHERE enquiry_id = $1',
          [finalEnquiryId]
        );
        if (exists.rows.length === 0) break;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // derived stage + status (status must be DB-safe)
      const initialStage = assigned_to ? 'in_discussion' : 'new';
      const initialStatus = normalizeStatus(status, { assigned: !!assigned_to });

      // 1. Insert main enquiry (NEW + OLD COLUMNS)
      const enquiryResult = await client.query(
        `INSERT INTO enquiries (
          enquiry_id,
          company_name,
          contact_person,
          mail_id,
          phone_no,
          items_required,
          source,
          lead,
          tags,
          stage,
          assigned_to,
          assigned_by,
          assigned_at,
          due_date,
          status,
          last_discussion,
          next_interaction
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17
        )
        RETURNING *`,
        [
          finalEnquiryId,
          company_name.trim(),
          contact_person?.trim() || null,
          mail_id?.trim() || null,
          phone_no?.trim() || null,
          items_required?.trim() || null,
          source,
          finalLead,
          tags,
          initialStage,
          assigned_to,
          user?.user_id || null,
          assigned_to ? new Date() : null,
          due_date ? new Date(due_date) : null,
          initialStatus,
          last_discussion ? new Date(last_discussion) : null,
          next_interaction ? new Date(next_interaction) : null,
        ]
      );

      const enquiry = enquiryResult.rows[0];

      // alias for frontend compatibility (old `priority` prop)
      enquiry.priority = enquiry.lead;

      // 2. Log creation/assignment activity
      if (assigned_to && user?.user_id) {
        await client.query(
          `INSERT INTO enquiry_activities
             (enquiry_id, user_id, activity_type, message, mentions)
           VALUES
             ($1, $2, 'assignment', $3, $4)`,
          [
            enquiry.enquiry_id,
            user.user_id,
            `Assigned to you by ${user.name || 'someone'}`,
            [assigned_to],
          ]
        );
      }

      await client.query('COMMIT');

      // Emit real-time update
      if (io) {
        io.emit('enquiryUpdate', { ...enquiry, type: 'created' });
        if (assigned_to) {
          io.to(`user_${assigned_to}`).emit('notification', {
            type: 'assigned',
            enquiry,
          });
        }
      }

      logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${user?.user_id}`);
      return enquiry;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Create enquiry failed:', err);
      if (err.code === '23505') throw new Error('Enquiry ID already exists');
      throw err;
    } finally {
      client.release();
    }
  }

  // =================================================================
  // GET ALL ENQUIRIES (with role-based filtering, returns old columns too)
  // =================================================================
  static async getAll({ limit = 15, cursor, user }) {
    const isDesign = user?.role_name === 'Design';

    let query = `
      SELECT
        e.*,
        u.name  AS assigned_to_name,
        ub.name AS assigned_by_name
      FROM enquiries e
      LEFT JOIN users u  ON e.assigned_to = u.user_id
      LEFT JOIN users ub ON e.assigned_by = ub.user_id
    `;

    const values = [];
    const where = [];

    // Design only sees enquiries ever assigned to them
    if (isDesign) {
      where.push(`
        EXISTS (
          SELECT 1
          FROM enquiry_activities ea
          WHERE ea.enquiry_id = e.enquiry_id
            AND ea.mentions @> ARRAY[$${values.length + 1}::integer]
            AND ea.activity_type = 'assignment'
        )
      `);
      values.push(user.user_id);
    }

    // Cursor by created_at
    if (cursor) {
      where.push(`e.created_at < $${values.length + 1}`);
      values.push(cursor);
    }

    if (where.length) {
      query += ` WHERE ${where.join(' AND ')}`;
    }

    query += ` ORDER BY e.created_at DESC LIMIT $${values.length + 1}`;
    values.push(limit);

    const result = await pool.query(query, values);

    // alias lead -> priority for frontend compatibility
    const data = result.rows.map((row) => ({
      ...row,
      priority: row.lead,
    }));

    // total count with same visibility logic
    let totalResult;
    if (isDesign) {
      totalResult = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM enquiries e
        WHERE EXISTS (
          SELECT 1
          FROM enquiry_activities ea
          WHERE ea.enquiry_id = e.enquiry_id
            AND ea.mentions @> ARRAY[$1::integer]
            AND ea.activity_type = 'assignment'
        )
      `,
        [user.user_id]
      );
    } else {
      totalResult = await pool.query('SELECT COUNT(*) AS count FROM enquiries');
    }

    return {
      data,
      total: parseInt(totalResult.rows[0].count, 10),
      cursor: data.length ? data[data.length - 1].created_at : null,
    };
  }

  // =================================================================
  // GET SINGLE ENQUIRY + FULL ACTIVITY LOG (includes old columns too)
  // =================================================================
  static async getById(enquiryId, user) {
    const isDesign = user?.role_name === 'Design';

    // Visibility for Design
    if (isDesign) {
      const check = await pool.query(
        `
        SELECT 1
        FROM enquiry_activities
        WHERE enquiry_id = $1
          AND mentions @> ARRAY[$2::integer]
          AND activity_type = 'assignment'
      `,
        [enquiryId, user.user_id]
      );
      if (check.rows.length === 0) throw new Error('Forbidden');
    }

    const [enquiryRes, activitiesRes] = await Promise.all([
      pool.query(
        `
        SELECT
          e.*,
          u.name  AS assigned_to_name,
          ub.name AS assigned_by_name
        FROM enquiries e
        LEFT JOIN users u  ON e.assigned_to = u.user_id
        LEFT JOIN users ub ON e.assigned_by = ub.user_id
        WHERE e.enquiry_id = $1
      `,
        [enquiryId]
      ),
      pool.query(
        `
        SELECT a.*, u.name AS user_name
        FROM enquiry_activities a
        JOIN users u ON a.user_id = u.user_id
        WHERE a.enquiry_id = $1
        ORDER BY a.created_at ASC
      `,
        [enquiryId]
      ),
    ]);

    if (enquiryRes.rows.length === 0) throw new Error('Enquiry not found');

    const enquiryRow = enquiryRes.rows[0];
    const enquiry = {
      ...enquiryRow,
      priority: enquiryRow.lead, // alias
      activities: activitiesRes.rows,
    };

    return enquiry;
  }

  // =================================================================
  // UPDATE (old + new fields: lead, source, tags, due_date)
  // =================================================================
  static async update(
    enquiryId,
    {
      company_name,
      contact_person,
      mail_id,
      phone_no,
      items_required,
      status,
      last_discussion,
      next_interaction,

      // NEW - DB column is "lead"
      lead,
      priority,
      source,
      tags,
      due_date,
    },
    io
  ) {
    // Only change status if caller actually provided one;
    // otherwise leave it as is in DB.
    let safeStatus = null;
    if (typeof status !== 'undefined' && status !== null && status !== '') {
      safeStatus = normalizeStatus(status, { assigned: false });
    }

    const leadToUse =
      typeof lead !== 'undefined' || typeof priority !== 'undefined'
        ? normalizeLead(lead || priority)
        : null;

    const result = await pool.query(
      `
      UPDATE enquiries
      SET
        company_name    = COALESCE($1, company_name),
        contact_person  = COALESCE($2, contact_person),
        mail_id         = COALESCE($3, mail_id),
        phone_no        = COALESCE($4, phone_no),
        items_required  = COALESCE($5, items_required),
        status          = COALESCE($6, status),
        last_discussion = $7,
        next_interaction= $8,
        lead            = COALESCE($9, lead),
        source          = COALESCE($10, source),
        tags            = COALESCE($11, tags),
        due_date        = $12,
        updated_at      = CURRENT_TIMESTAMP
      WHERE enquiry_id  = $13
      RETURNING *
    `,
      [
        company_name || null,
        contact_person || null,
        mail_id || null,
        phone_no || null,
        items_required || null,
        safeStatus,
        last_discussion ? new Date(last_discussion) : null,
        next_interaction ? new Date(next_interaction) : null,
        leadToUse,
        source || null,
        Array.isArray(tags) ? tags : null,
        due_date ? new Date(due_date) : null,
        enquiryId,
      ]
    );

    if (result.rows.length === 0) throw new Error('Enquiry not found');

    const enquiry = result.rows[0];
    enquiry.priority = enquiry.lead; // alias

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'updated' });
    }

    logger.info(`Enquiry updated (extended): ${enquiry.enquiry_id}`);
    return enquiry;
  }

  // =================================================================
  // ASSIGN / ESCALATE
  // =================================================================
  static async assign(enquiryId, { assigned_to, due_date, message }, io, user) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `
        UPDATE enquiries
        SET
          assigned_to = $1,
          assigned_by = $2,
          assigned_at = NOW(),
          due_date    = $3,
          stage       = 'in_discussion',
          status      = 'In Progress'  -- ✅ valid according to constraint
        WHERE enquiry_id = $4
        RETURNING *
      `,
        [assigned_to, user.user_id, due_date || null, enquiryId]
      );

      if (res.rows.length === 0) throw new Error('Enquiry not found');

      await client.query(
        `
        INSERT INTO enquiry_activities
          (enquiry_id, user_id, activity_type, message, mentions)
        VALUES
          ($1, $2, 'assignment', $3, $4)
      `,
        [
          enquiryId,
          user.user_id,
          message || `Assigned by ${user.name}`,
          [assigned_to],
        ]
      );

      await client.query('COMMIT');

      const enquiry = res.rows[0];
      enquiry.priority = enquiry.lead; // alias

      if (io) {
        io.emit('enquiryUpdate', { ...enquiry, type: 'assigned' });
        io.to(`user_${assigned_to}`).emit('notification', {
          type: 'assigned',
          enquiry,
        });
      }

      return enquiry;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =================================================================
  // ADD COMMENT / @MENTION
  // =================================================================
  static async addComment(
    enquiryId,
    { message, mentions = [], expected_by, is_internal },
    io,
    user
  ) {
    const res = await pool.query(
      `
      INSERT INTO enquiry_activities
        (enquiry_id, user_id, activity_type, message, mentions, expected_by, is_internal)
      VALUES
        ($1, $2, 'comment', $3, $4, $5, $6)
      RETURNING *,
        (SELECT name FROM users WHERE user_id = $2) AS user_name
    `,
      [
        enquiryId,
        user.user_id,
        message,
        mentions,
        expected_by || null,
        is_internal || false,
      ]
    );

    const activity = res.rows[0];

    if (io) {
      io.emit('enquiryActivity', { enquiryId, activity });
      mentions.forEach((id) =>
        io.to(`user_${id}`).emit('notification', {
          type: 'mention',
          activity,
        })
      );
    }

    return activity;
  }

  // =================================================================
  // CHANGE STAGE (close won, regret, etc.) – also syncs status (DB-safe)
  // =================================================================
  static async changeStage(enquiryId, { stage, note }, io, user) {
    const validStages = [
      'closed_won',
      'closed_lost',
      'regret',
      'in_discussion',
      'design_review',
      'admin_review',
    ];
    if (!validStages.includes(stage)) throw new Error('Invalid stage');

    // Map stage → one of the 4 allowed statuses
    const stageToStatus = {
      closed_won: 'Closed',
      closed_lost: 'Closed',
      regret: 'Cancelled',
      in_discussion: 'In Progress',
      design_review: 'In Progress',
      admin_review: 'In Progress',
    };

    const status = stageToStatus[stage] || 'In Progress';

    const res = await pool.query(
      `
      UPDATE enquiries
      SET stage = $1,
          status = $2,
          updated_at = NOW()
      WHERE enquiry_id = $3
      RETURNING *
    `,
      [stage, status, enquiryId]
    );

    if (res.rows.length === 0) throw new Error('Enquiry not found');

    // Log stage change as comment activity
    await Enquiry.addComment(
      enquiryId,
      {
        message:
          note ||
          `Stage changed to ${(stage || '').replace('_', ' ')}`,
        mentions: [],
      },
      io,
      user
    );

    const enquiry = res.rows[0];
    enquiry.priority = enquiry.lead; // alias

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'stage_change' });
    }

    return enquiry;
  }

  // =================================================================
  // AUTO-OVERDUE CHECK (call from cron every hour)
  // =================================================================
  static async checkOverdue(io) {
    const result = await pool.query(
      `
      SELECT e.*, u.name
      FROM enquiries e
      JOIN users u ON e.assigned_to = u.user_id
      WHERE e.due_date < NOW()
        AND e.stage NOT IN ('closed_won', 'closed_lost', 'regret')
        AND NOT EXISTS (
          SELECT 1
          FROM enquiry_activities
          WHERE enquiry_id = e.enquiry_id
            AND activity_type = 'system'
            AND message LIKE '%overdue%'
            AND created_at > NOW() - INTERVAL '1 hour'
        )
    `
    );

    for (const e of result.rows) {
      const hoursOverdue = Math.floor(
        (Date.now() - new Date(e.due_date).getTime()) / 3600000
      );

      await Enquiry.addComment(
        e.enquiry_id,
        {
          message: `@${e.name} This enquiry is overdue by ${hoursOverdue} hours!`,
          mentions: [e.assigned_to],
        },
        io,
        { user_id: 0, name: 'System' }
      );
    }
  }

  // =================================================================
  // OPTIONAL: DELETE (if you still need hard delete)
  // =================================================================
  static async delete(enquiryId, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'DELETE FROM enquiry_activities WHERE enquiry_id = $1',
        [enquiryId]
      );

      const result = await client.query(
        'DELETE FROM enquiries WHERE enquiry_id = $1 RETURNING *',
        [enquiryId]
      );

      if (result.rows.length === 0) throw new Error('Enquiry not found');

      const enquiry = result.rows[0];
      enquiry.priority = enquiry.lead; // alias

      await client.query('COMMIT');

      if (io) {
        io.emit('enquiryUpdate', {
          enquiry_id: enquiry.enquiry_id,
          status: 'Deleted',
          type: 'deleted',
        });
      }

      logger.info(`Enquiry deleted: ${enquiry.enquiry_id}`);
      return enquiry;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Error deleting enquiry ${enquiryId}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = Enquiry;
