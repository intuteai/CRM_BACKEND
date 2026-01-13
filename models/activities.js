// models/activities.js

const pool = require('../config/db');
const { sendEmail } = require('../utils/email');
const { generateNewTaskAssignmentHtml } = require('../utils/emailTemplates');

class Activities {
  static #toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch {}
  }

  // Updated payload to include comments
  static #toPayload(row, assignees = []) {
    return {
      id: row.id,
      summary: row.summary,
      status: row.status,
      due_date: row.due_date,
      priority: row.priority,
      comments: row.comments || '',
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      assignees: assignees.map(a => ({
        user_id: a.user_id,
        name: a.name || 'Unknown',
        email: a.email || null,
        assigned_at: a.assigned_at,
      })),
    };
  }

  static #wrapDbError(err) {
    if (err?.code === '23503') {
      const msg = err.constraint?.includes('user_id')
        ? 'Assignee user not found'
        : 'Related record not found';
      const e = new Error(msg);
      e.cause = err;
      return e;
    }
    return err;
  }

  // ==================== CREATE ====================
  static async create({ summary, status, assignee_ids = [], due_date, priority, comments = '' }, io) {
    if (!summary || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      throw new Error('Summary and at least one assignee_id required');
    }

    const _status = status || 'todo';
    const _priority = priority || 'medium';
    const _comments = comments?.trim() || '';
    const createdById = io?.user?.user_id ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const actRes = await client.query(`
        INSERT INTO activities (summary, status, due_date, priority, comments, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, summary, status, due_date, priority, comments, created_by, created_at, updated_at
      `, [summary, _status, due_date ?? null, _priority, _comments, createdById]);

      const activityId = actRes.rows[0].id;

      if (assignee_ids.length > 0) {
        const values = assignee_ids
          .filter(id => Number.isFinite(this.#toNumber(id)))
          .map(id => `(${activityId}, ${id})`)
          .join(', ');

        if (values) {
          await client.query(`
            INSERT INTO activity_assignees (activity_id, user_id)
            VALUES ${values}
            ON CONFLICT DO NOTHING
          `);
        }
      }

      // Fetch assignees
      const assigneesRes = await client.query(`
        SELECT aa.user_id, u.name, u.email, aa.assigned_at
        FROM activity_assignees aa
        JOIN users u ON u.user_id = aa.user_id
        WHERE aa.activity_id = $1
      `, [activityId]);

      // Fetch creator's name (for nice email)
      let createdByName = 'System';
      if (createdById) {
        const creatorRes = await client.query(`
          SELECT name FROM users WHERE user_id = $1
        `, [createdById]);
        if (creatorRes.rows.length > 0 && creatorRes.rows[0].name?.trim()) {
          createdByName = creatorRes.rows[0].name.trim();
        }
      }

      await client.query('COMMIT');

      const activity = this.#toPayload(actRes.rows[0], assigneesRes.rows);
      this.#safeEmit(io, 'activities:created', activity);

      // ──────────────────────────────────────────────────────────────
      // Send beautiful assignment notification
      try {
        console.log(`[EMAIL] Starting assignment notifications for activity ${activityId}`);
        console.log(`[EMAIL] Found ${assigneesRes.rows.length} assignees`);

        const dueDateStr = due_date 
          ? new Date(due_date).toLocaleDateString('en-IN', { 
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
            })
          : 'No due date set';

        for (const assignee of assigneesRes.rows) {
          const emailAddress = assignee.email?.trim();

          console.log(`[EMAIL] Checking assignee ${assignee.user_id} (${assignee.name || 'Unknown'}): email = ${emailAddress || 'MISSING'}`);

          if (!emailAddress || typeof emailAddress !== 'string' || !emailAddress.includes('@')) {
            console.log(`[EMAIL] Skipping assignee ${assignee.user_id} - invalid or missing email`);
            continue;
          }

          const subject = `New Task Assigned to You - ${summary}`;

          // Plain text fallback
          const text = 
            `Hello ${assignee.name || 'Team Member'},\n\n` +
            `You have been assigned a new activity:\n\n` +
            `• Summary: ${summary}\n` +
            `• Priority: ${priority || _priority}\n` +
            `• Due date: ${dueDateStr}\n` +
            `• Status: ${_status}\n\n` +
            `You can view and manage this task here:\n` +
            `https://intute.biz/activities/${activityId}\n\n` +
            `Best regards,\nIntute ERP Team`;

          // Beautiful HTML version
          const html = generateNewTaskAssignmentHtml({
            userName: assignee.name || 'Team Member',
            taskSummary: summary,
            priority: priority || _priority,
            status: _status,
            dueDate: dueDateStr,
            taskId: activityId,
            createdBy: createdByName  // ← uses actual name (e.g. "Rahul")
          });

          console.log(`[EMAIL] Sending to ${emailAddress} with subject: ${subject}`);

          const sent = await sendEmail({
            to: emailAddress,
            subject,
            text,
            html
          });

          if (sent) {
            console.log(`[EMAIL] Successfully sent to ${emailAddress}`);
          } else {
            console.log(`[EMAIL] Failed to send to ${emailAddress}`);
          }
        }
      } catch (emailError) {
        console.error('[EMAIL] Error during assignment notifications:', emailError.message);
      }
      // ──────────────────────────────────────────────────────────────

      return activity;
    } catch (error) {
      await client.query('ROLLBACK');
      throw this.#wrapDbError(error);
    } finally {
      client.release();
    }
  }

  // ==================== UPDATE ====================
  static async update(id, { summary, status, assignee_ids, due_date, priority, comments }, io) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid activity id');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fields = [];
      const values = [];
      let idx = 1;

      if (summary !== undefined) { fields.push(`summary = $${idx++}`); values.push(summary); }
      if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
      if (due_date !== undefined) { fields.push(`due_date = $${idx++}`); values.push(due_date); }
      if (priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(priority); }
      if (comments !== undefined) { fields.push(`comments = $${idx++}`); values.push(comments?.trim() || ''); }

      fields.push(`updated_at = NOW()`);
      values.push(_id);

      if (fields.length === 1) {
        throw new Error('No fields to update');
      }

      const updateQuery = `
        UPDATE activities
        SET ${fields.join(', ')}
        WHERE id = $${idx}
        RETURNING id, summary, status, due_date, priority, comments, created_by, created_at, updated_at
      `;

      const actRes = await client.query(updateQuery, values);
      if (actRes.rows.length === 0) throw new Error('Activity not found');

      if (assignee_ids !== undefined) {
        await client.query('DELETE FROM activity_assignees WHERE activity_id = $1', [_id]);
        if (Array.isArray(assignee_ids) && assignee_ids.length > 0) {
          const validIds = assignee_ids
            .map(id => this.#toNumber(id))
            .filter(n => Number.isFinite(n));
          if (validIds.length > 0) {
            const placeholders = validIds.map((_, i) => `($1, $${i + 2})`).join(', ');
            const insertQuery = `
              INSERT INTO activity_assignees (activity_id, user_id)
              VALUES ${placeholders}
              ON CONFLICT DO NOTHING
            `;
            await client.query(insertQuery, [_id, ...validIds]);
          }
        }
      }

      const assigneesRes = await client.query(`
        SELECT aa.user_id, u.name, u.email, aa.assigned_at
        FROM activity_assignees aa
        JOIN users u ON u.user_id = aa.user_id
        WHERE aa.activity_id = $1
      `, [_id]);

      await client.query('COMMIT');
      const activity = this.#toPayload(actRes.rows[0], assigneesRes.rows);
      this.#safeEmit(io, 'activities:updated', activity);
      return activity;
    } catch (error) {
      await client.query('ROLLBACK');
      throw this.#wrapDbError(error);
    } finally {
      client.release();
    }
  }

  // ==================== GET ALL ====================
  static async getAll({ limit = 10, cursor = null } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);

    const query = `
      SELECT 
        a.id, a.summary, a.status, a.due_date, a.priority, a.comments,
        a.created_by, a.created_at, a.updated_at,
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'user_id', aa.user_id,
              'name', u.name,
              'email', u.email,
              'assigned_at', aa.assigned_at
            )
          )
          FROM activity_assignees aa
          JOIN users u ON u.user_id = aa.user_id
          WHERE aa.activity_id = a.id
        ), '[]') AS assignees
      FROM activities a
      WHERE ($1::timestamp IS NULL OR a.created_at < $1::timestamp)
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2
    `;

    const totalQuery = 'SELECT COUNT(*)::int FROM activities';

    const [result, totalRes] = await Promise.all([
      pool.query(query, [cursor, _limit]),
      pool.query(totalQuery),
    ]);

    const data = result.rows.map(row => this.#toPayload(row, row.assignees || []));

    const nextCursor = data.length > 0 ? data[data.length - 1].created_at : null;

    return {
      data,
      total: totalRes.rows[0].count,
      cursor: nextCursor,
    };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid activity id');

    const query = `
      SELECT 
        a.*, 
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'user_id', aa.user_id,
              'name', u.name,
              'email', u.email,
              'assigned_at', aa.assigned_at
            )
          )
          FROM activity_assignees aa
          JOIN users u ON u.user_id = aa.user_id
          WHERE aa.activity_id = a.id
        ), '[]') AS assignees
      FROM activities a
      WHERE a.id = $1
    `;

    const res = await pool.query(query, [_id]);
    if (res.rows.length === 0) throw new Error('Activity not found');

    const row = res.rows[0];
    return this.#toPayload(row, row.assignees || []);
  }

  // ==================== DELETE ====================
  static async delete(id, io) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid activity id');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(`
        DELETE FROM activities WHERE id = $1
        RETURNING id
      `, [_id]);
      if (res.rows.length === 0) throw new Error('Activity not found');

      await client.query('COMMIT');
      const activity = { id: res.rows[0].id };
      this.#safeEmit(io, 'activities:deleted', activity);
      return activity;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Activities;