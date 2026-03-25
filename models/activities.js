// models/activities.js

const pool = require('../config/db');
const { sendEmail } = require('../utils/email');
const { generateNewTaskAssignmentHtml } = require('../utils/emailTemplates');

// ── Org / Role constants ─────────────────────────────────────
const IA_ROLES = [11, 12];
const COM_ROLES = [9, 10];
const COM_EMPLOYEE_ROLE = 9;

function resolveOrg(roleId) {
  if (IA_ROLES.includes(roleId)) return 'ia';
  if (COM_ROLES.includes(roleId)) return 'com';
  return null;
}

class Activities {
  static #toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  static #safeEmit(io, event, payload) {
    if (!io || typeof io.emit !== 'function') return;
    try { io.emit(event, payload); } catch {}
  }

  static #toPayload(row, assignees = []) {
    return {
      id: row.id,
      summary: row.summary,
      status: row.status,
      due_date: row.due_date,
      priority: row.priority,
      comments: row.comments || '',
      org: row.org,
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
  static async create(
    { summary, status, assignee_ids = [], due_date, priority, comments = '' },
    io
  ) {
    if (!summary || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      throw new Error('Summary and at least one assignee_id required');
    }

    const roleId = io?.user?.role_id ?? null;
    const org = resolveOrg(roleId);
    if (!org) throw new Error('Unable to determine org from user role');

    const _status = status || 'todo';
    const _priority = priority || 'medium';
    const _comments = comments?.trim() || '';
    const createdById = io?.user?.user_id ?? null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const actRes = await client.query(
        `INSERT INTO activities (summary, status, due_date, priority, comments, created_by, org)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, summary, status, due_date, priority, comments, org, created_by, created_at, updated_at`,
        [summary, _status, due_date ?? null, _priority, _comments, createdById, org]
      );

      const activityId = actRes.rows[0].id;

      if (assignee_ids.length > 0) {
        const values = assignee_ids
          .filter(id => Number.isFinite(this.#toNumber(id)))
          .map(id => `(${activityId}, ${id})`)
          .join(', ');

        if (values) {
          await client.query(
            `INSERT INTO activity_assignees (activity_id, user_id)
             VALUES ${values}
             ON CONFLICT DO NOTHING`
          );
        }
      }

      const assigneesRes = await client.query(
        `SELECT aa.user_id, u.name, u.email, aa.assigned_at
         FROM activity_assignees aa
         JOIN users u ON u.user_id = aa.user_id
         WHERE aa.activity_id = $1`,
        [activityId]
      );

      let createdByName = 'System';
      if (createdById) {
        const creatorRes = await client.query(
          `SELECT name FROM users WHERE user_id = $1`,
          [createdById]
        );
        if (creatorRes.rows.length > 0 && creatorRes.rows[0].name?.trim()) {
          createdByName = creatorRes.rows[0].name.trim();
        }
      }

      await client.query('COMMIT');

      const activity = this.#toPayload(actRes.rows[0], assigneesRes.rows);
      this.#safeEmit(io, 'activities:created', activity);

      // ── Email: IA only ───────────────────────────────────
      if (org === 'ia') {
        setImmediate(async () => {
          try {
            console.log(`[EMAIL] Starting assignment notifications for activity ${activityId}`);

            const dueDateStr = due_date
              ? new Date(due_date).toLocaleDateString('en-IN', {
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                })
              : 'No due date set';

            for (const assignee of assigneesRes.rows) {
              const emailAddress = assignee.email?.trim();
              if (!emailAddress || !emailAddress.includes('@')) {
                console.log(`[EMAIL] Skipping assignee ${assignee.user_id} - invalid/missing email`);
                continue;
              }

              const subject = `New Task Assigned to You - ${summary}`;
              const text =
                `Hello ${assignee.name || 'Team Member'},\n\n` +
                `You have been assigned a new activity:\n\n` +
                `• Summary: ${summary}\n` +
                `• Priority: ${_priority}\n` +
                `• Due date: ${dueDateStr}\n` +
                `• Status: ${_status}\n\n` +
                `You can view and manage this task here:\n` +
                `https://intute.biz/activities/${activityId}\n\n` +
                `Best regards,\nIntute ERP Team`;

              const html = generateNewTaskAssignmentHtml({
                userName: assignee.name || 'Team Member',
                taskSummary: summary,
                priority: _priority,
                status: _status,
                dueDate: dueDateStr,
                taskId: activityId,
                createdBy: createdByName,
              });

              const sent = await sendEmail({ to: emailAddress, subject, text, html });
              console.log(`[EMAIL] ${sent ? 'Sent' : 'Failed'} → ${emailAddress}`);
            }
          } catch (emailError) {
            console.error('[EMAIL] Error during assignment notifications:', emailError.message);
          }
        });
      }

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

      if (summary !== undefined)  { fields.push(`summary = $${idx++}`);  values.push(summary); }
      if (status !== undefined)   { fields.push(`status = $${idx++}`);   values.push(status); }
      if (due_date !== undefined) { fields.push(`due_date = $${idx++}`); values.push(due_date); }
      if (priority !== undefined) { fields.push(`priority = $${idx++}`); values.push(priority); }
      if (comments !== undefined) { fields.push(`comments = $${idx++}`); values.push(comments?.trim() || ''); }

      fields.push(`updated_at = NOW()`);
      values.push(_id);

      if (fields.length === 1) throw new Error('No fields to update');

      const actRes = await client.query(
        `UPDATE activities
         SET ${fields.join(', ')}
         WHERE id = $${idx}
         RETURNING id, summary, status, due_date, priority, comments, org, created_by, created_at, updated_at`,
        values
      );
      if (actRes.rows.length === 0) throw new Error('Activity not found');

      if (assignee_ids !== undefined) {
        await client.query('DELETE FROM activity_assignees WHERE activity_id = $1', [_id]);
        if (Array.isArray(assignee_ids) && assignee_ids.length > 0) {
          const validIds = assignee_ids
            .map(id => this.#toNumber(id))
            .filter(n => Number.isFinite(n));
          if (validIds.length > 0) {
            const placeholders = validIds.map((_, i) => `($1, $${i + 2})`).join(', ');
            await client.query(
              `INSERT INTO activity_assignees (activity_id, user_id)
               VALUES ${placeholders}
               ON CONFLICT DO NOTHING`,
              [_id, ...validIds]
            );
          }
        }
      }

      const assigneesRes = await client.query(
        `SELECT aa.user_id, u.name, u.email, aa.assigned_at
         FROM activity_assignees aa
         JOIN users u ON u.user_id = aa.user_id
         WHERE aa.activity_id = $1`,
        [_id]
      );

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
  // requestingUser: { user_id, role_id }
  static async getAll({ limit = 10, cursor = null, requestingUser } = {}) {
    const _limit = Math.min(Math.max(Number(limit) || 10, 1), 100);

    const org = resolveOrg(requestingUser?.role_id);
    if (!org) throw new Error('Unable to determine org from user role');

    const isCompageEmployee = requestingUser?.role_id === COM_EMPLOYEE_ROLE;

    // ── Cursor parsing ───────────────────────────────────
    let cursorId = null;
    let cursorCreatedAt = null;
    if (cursor) {
      try {
        if (cursor.includes(':')) {
          const [id, timestamp] = cursor.split(':');
          cursorId = parseInt(id, 10);
          cursorCreatedAt = timestamp;
        } else {
          cursorCreatedAt = cursor;
        }
      } catch {
        console.warn('Invalid cursor format:', cursor);
      }
    }

    // ── Compage Employee: only see their own assigned activities ──
    if (isCompageEmployee) {
      const query = `
        SELECT
          a.id, a.summary, a.status, a.due_date, a.priority, a.comments,
          a.org, a.created_by, a.created_at, a.updated_at,
          COALESCE((
            SELECT JSON_AGG(
              JSON_BUILD_OBJECT(
                'user_id', aa2.user_id,
                'name', u2.name,
                'email', u2.email,
                'assigned_at', aa2.assigned_at
              )
            )
            FROM activity_assignees aa2
            JOIN users u2 ON u2.user_id = aa2.user_id
            WHERE aa2.activity_id = a.id
          ), '[]') AS assignees
        FROM activities a
        JOIN activity_assignees aa ON aa.activity_id = a.id
        WHERE a.org = $1
          AND aa.user_id = $2
          AND (
            $3::timestamp IS NULL
            OR a.created_at < $3::timestamp
            OR (a.created_at = $3::timestamp AND a.id < $4)
          )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $5
      `;

      const countQuery = `
        SELECT COUNT(DISTINCT a.id)::int
        FROM activities a
        JOIN activity_assignees aa ON aa.activity_id = a.id
        WHERE a.org = $1 AND aa.user_id = $2
      `;

      const [result, totalRes] = await Promise.all([
        pool.query(query, [org, requestingUser.user_id, cursorCreatedAt, cursorId, _limit]),
        pool.query(countQuery, [org, requestingUser.user_id]),
      ]);

      const data = result.rows.map(row => this.#toPayload(row, row.assignees || []));
      const nextCursor = data.length === _limit && data.length > 0
        ? `${data[data.length - 1].id}:${data[data.length - 1].created_at}`
        : null;

      return { data, total: totalRes.rows[0].count, cursor: nextCursor };
    }

    // ── IA / Compage HR: see all activities in their org ──
    const query = `
      SELECT
        a.id, a.summary, a.status, a.due_date, a.priority, a.comments,
        a.org, a.created_by, a.created_at, a.updated_at,
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
      WHERE a.org = $1
        AND (
          $2::timestamp IS NULL
          OR a.created_at < $2::timestamp
          OR (a.created_at = $2::timestamp AND a.id < $3)
        )
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $4
    `;

    const countQuery = `SELECT COUNT(*)::int FROM activities WHERE org = $1`;

    const [result, totalRes] = await Promise.all([
      pool.query(query, [org, cursorCreatedAt, cursorId, _limit]),
      pool.query(countQuery, [org]),
    ]);

    const data = result.rows.map(row => this.#toPayload(row, row.assignees || []));
    const nextCursor = data.length === _limit && data.length > 0
      ? `${data[data.length - 1].id}:${data[data.length - 1].created_at}`
      : null;

    return { data, total: totalRes.rows[0].count, cursor: nextCursor };
  }

  // ==================== GET BY ID ====================
  static async getById(id) {
    const _id = this.#toNumber(id);
    if (!Number.isFinite(_id)) throw new Error('Invalid activity id');

    const res = await pool.query(
      `SELECT
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
       WHERE a.id = $1`,
      [_id]
    );

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
      const res = await client.query(
        `DELETE FROM activities WHERE id = $1 RETURNING id`,
        [_id]
      );
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