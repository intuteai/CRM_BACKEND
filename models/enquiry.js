// models/enquiry.js
const pool = require('../config/db');
const logger = require('../utils/logger');

const VALID_STATUSES = ['Pending', 'In Progress', 'Closed', 'Cancelled'];
const VALID_LEADS = ['hotlead', 'followup', 'lead', 'not_interested', 'closed'];

function normalizeStatus(input, { assigned = false } = {}) {
  if (input && VALID_STATUSES.includes(input)) return input;
  return assigned ? 'In Progress' : 'Pending';
}

function normalizeLead(raw) {
  if (!raw) return 'lead';
  const lower = String(raw).toLowerCase();
  return VALID_LEADS.includes(lower) ? lower : 'lead';
}

async function fetchUserName(userId) {
  if (!userId) return null;
  try {
    const r = await pool.query('SELECT name FROM users WHERE user_id = $1', [userId]);
    return r.rows.length ? r.rows[0].name : null;
  } catch (err) {
    logger.warn('Failed to fetch user name for', userId, err);
    return null;
  }
}

class Enquiry {
  // =================================================================
  // CREATE NEW ENQUIRY
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
      application = null,
      lead,
      priority,
      tags = [],
      assigned_to = null,
      due_date = null,
      status = 'Pending',
      last_discussion = null,
      next_interaction = null,
    } = data;

    if (!company_name?.trim()) throw new Error('Company name is required');

    const finalLead = normalizeLead(lead || priority || 'lead');

    let finalEnquiryId = enquiry_id;
    if (!finalEnquiryId) {
      try {
        const idRes = await pool.query('SELECT get_next_enquiry_id() AS id');
        finalEnquiryId = idRes.rows[0].id;
      } catch (err) {
        finalEnquiryId = `ENQ${new Date().getFullYear()}${String(
          Math.floor(1000 + Math.random() * 9000)
        )}`;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const initialStage = assigned_to ? 'in_discussion' : 'new';
      const initialStatus = normalizeStatus(status, { assigned: !!assigned_to });

      // NOTE: added created_by column (last parameter)
      const enquiryResult = await client.query(
        `INSERT INTO enquiries (
          enquiry_id,
          company_name,
          contact_person,
          mail_id,
          phone_no,
          items_required,
          source,
          application,
          lead,
          tags,
          stage,
          assigned_to,
          assigned_by,
          assigned_at,
          due_date,
          status,
          last_discussion,
          next_interaction,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18, $19
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
          application || null,
          finalLead,
          tags,
          initialStage,
          assigned_to,
          user?.user_id || null, // assigned_by
          assigned_to ? new Date() : null, // assigned_at
          due_date ? new Date(due_date) : null,
          initialStatus,
          last_discussion ? new Date(last_discussion) : null,
          next_interaction ? new Date(next_interaction) : null,
          user?.user_id || null, // created_by (NEW)
        ]
      );

      const enquiry = enquiryResult.rows[0];
      enquiry.priority = enquiry.lead;

      // attach created_by_name for convenience
      enquiry.created_by_name = user?.name || (await fetchUserName(enquiry.created_by));

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
  // GET ALL ENQUIRIES (Design sees only currently assigned to them)
  // =================================================================
  static async getAll({ limit = 15, offset = 0, cursor, user }) {
    const isDesign = String(user?.role_name || '').toLowerCase().includes('design');
    const userId = Number(user?.user_id);

    if (isDesign && (!userId || Number.isNaN(userId))) {
      logger.warn('Design user with no numeric user_id attempted getAll, returning empty list');
      return { data: [], total: 0, cursor: null };
    }

    // include created_by_name via join
    let query = `
      SELECT
        e.*,
        u.name  AS assigned_to_name,
        ub.name AS assigned_by_name,
        uc.name AS created_by_name
      FROM enquiries e
      LEFT JOIN users u  ON e.assigned_to = u.user_id
      LEFT JOIN users ub ON e.assigned_by = ub.user_id
      LEFT JOIN users uc ON e.created_by = uc.user_id
    `;

    const values = [];
    const where = [];

    if (isDesign) {
      where.push(`e.assigned_to = $${values.length + 1}::int`);
      values.push(userId);
    }

    if (cursor) {
      where.push(`e.created_at < $${values.length + 1}`);
      values.push(cursor);
    }

    if (where.length) {
      query += ` WHERE ${where.join(' AND ')}`;
    }

    query += ` ORDER BY e.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(limit);
    values.push(offset);

    logger.debug('getAll query values', { isDesign, values });

    const result = await pool.query(query, values);

    const data = result.rows.map((row) => ({
      ...row,
      priority: row.lead,
    }));

    let totalResult;
    if (isDesign) {
      totalResult = await pool.query(
        `SELECT COUNT(*) AS count FROM enquiries WHERE assigned_to = $1::int`,
        [userId]
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
  // GET SINGLE ENQUIRY + ACTIVITIES (Design must be current assignee)
  // =================================================================
  static async getById(enquiryId, user) {
    const isDesign = String(user?.role_name || '').toLowerCase().includes('design');
    const userId = Number(user?.user_id);

    if (isDesign) {
      if (!userId || Number.isNaN(userId)) {
        logger.warn('Design user with invalid id attempted getById', { enquiryId, user });
        throw new Error('Forbidden');
      }
      const check = await pool.query(
        `SELECT 1 FROM enquiries WHERE enquiry_id = $1 AND assigned_to = $2::int`,
        [enquiryId, userId]
      );
      if (check.rows.length === 0) {
        logger.warn(`Design user ${userId} attempted to access unassigned enquiry ${enquiryId}`);
        throw new Error('Forbidden');
      }
    }

    const [enquiryRes, activitiesRes] = await Promise.all([
      pool.query(
        `
        SELECT
          e.*,
          u.name  AS assigned_to_name,
          ub.name AS assigned_by_name,
          uc.name AS created_by_name
        FROM enquiries e
        LEFT JOIN users u  ON e.assigned_to = u.user_id
        LEFT JOIN users ub ON e.assigned_by = ub.user_id
        LEFT JOIN users uc ON e.created_by = uc.user_id
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

    if (enquiryRes.rows.length === 0) {
      throw new Error('Enquiry not found');
    }

    const enquiryRow = enquiryRes.rows[0];
    const enquiry = {
      ...enquiryRow,
      priority: enquiryRow.lead,
      activities: activitiesRes.rows,
    };

    return enquiry;
  }

  // =================================================================
  // UPDATE
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
      lead,
      priority,
      source,
      application,
      tags,
      due_date,
    },
    io
  ) {
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
        application     = COALESCE($10, application),
        source          = COALESCE($11, source),
        tags            = COALESCE($12, tags),
        due_date        = $13,
        updated_at      = CURRENT_TIMESTAMP
      WHERE enquiry_id  = $14
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
        typeof application !== 'undefined' ? application : null,
        source || null,
        Array.isArray(tags) ? tags : null,
        due_date ? new Date(due_date) : null,
        enquiryId,
      ]
    );

    if (result.rows.length === 0) throw new Error('Enquiry not found');

    const enquiry = result.rows[0];
    enquiry.priority = enquiry.lead;

    // attach created_by_name if possible
    enquiry.created_by_name = enquiry.created_by
      ? await fetchUserName(enquiry.created_by)
      : null;

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'updated' });
    }

    logger.info(`Enquiry updated (extended): ${enquiry.enquiry_id}`);
    return enquiry;
  }

  // =================================================================
  // ASSIGN
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
          status      = 'In Progress',
          updated_at  = NOW()
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
      enquiry.priority = enquiry.lead;
      enquiry.created_by_name = enquiry.created_by ? await fetchUserName(enquiry.created_by) : null;

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
  // markDone
  // =================================================================
  static async markDone(enquiryId, designUser, salesUserId = 7, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const chk = await client.query(
        `SELECT assigned_to, assigned_by, stage FROM enquiries WHERE enquiry_id = $1 FOR UPDATE`,
        [enquiryId]
      );
      if (chk.rows.length === 0) throw new Error('Enquiry not found');

      const current = chk.rows[0];
      if (current.assigned_to !== designUser.user_id) {
        throw new Error('You are not the current assignee');
      }

      const upd = await client.query(
        `
        UPDATE enquiries
        SET assigned_to = $1,
            assigned_by = $2,
            assigned_at = NOW(),
            stage       = 'in_discussion',
            status      = 'In Progress',
            updated_at  = NOW()
        WHERE enquiry_id = $3
        RETURNING *
      `,
        [salesUserId, designUser.user_id, enquiryId]
      );

      const updatedEnquiry = upd.rows[0];

      await client.query(
        `
        INSERT INTO enquiry_activities
          (enquiry_id, user_id, activity_type, message, mentions)
        VALUES ($1, $2, 'assignment', $3, $4)
      `,
        [
          enquiryId,
          designUser.user_id,
          `Design completed work and returned enquiry to Sales (user ${salesUserId})`,
          [salesUserId],
        ]
      );

      await client.query('COMMIT');

      updatedEnquiry.priority = updatedEnquiry.lead;
      updatedEnquiry.created_by_name = updatedEnquiry.created_by
        ? await fetchUserName(updatedEnquiry.created_by)
        : null;

      if (io) {
        io.emit('enquiryUpdate', { ...updatedEnquiry, type: 'assigned' });
        io.to(`user_${salesUserId}`).emit('notification', {
          type: 'assigned',
          enquiry: updatedEnquiry,
        });
      }

      logger.info(
        `Enquiry ${enquiryId} marked done by design ${designUser.user_id}, returned to ${salesUserId}`
      );
      return updatedEnquiry;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =================================================================
  // addComment
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
  // changeStage, checkOverdue, delete
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
    enquiry.priority = enquiry.lead;
    enquiry.created_by_name = enquiry.created_by ? await fetchUserName(enquiry.created_by) : null;

    if (io) {
      io.emit('enquiryUpdate', { ...enquiry, type: 'stage_change' });
    }

    return enquiry;
  }

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
      enquiry.priority = enquiry.lead;
      enquiry.created_by_name = enquiry.created_by ? await fetchUserName(enquiry.created_by) : null;

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
