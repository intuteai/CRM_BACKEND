const Enquiry = require('../../models/sales/enquiry');
const redis = require('../../config/redis');
const pool = require('../../config/db');
const logger = require('../../utils/logger');

async function deleteByPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(keys);
}

exports.getTemplates = async (req, res) => {
  try {
    const result = await pool.query('SELECT id, title, content FROM comment_templates WHERE is_global = true ORDER BY title');
    res.json(result.rows);
  } catch (err) {
    logger.error('Get templates error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
};

exports.refreshCache = async (req, res) => {
  try {
    await deleteByPattern('enquiry_*');
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry caches invalidated by ${req.user.user_id}`);
    res.json({ message: 'Enquiry caches invalidated successfully' });
  } catch (error) {
    logger.error(`Error invalidating enquiry caches: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.create = async (req, res) => {
  try {
    const { enquiry_id, company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, source = 'Website', application = null, lead, priority, tags = [], assigned_to, due_date } = req.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'Company name is required', code: 'INVALID_INPUT' });
    const enquiry = await Enquiry.create({ enquiry_id, company_name: company_name.trim(), contact_person: contact_person?.trim() || null, mail_id: mail_id?.trim() || null, phone_no: phone_no?.trim() || null, items_required: items_required?.trim() || null, status, last_discussion, next_interaction, source, application, lead, priority, tags, assigned_to: assigned_to || null, due_date: due_date || null }, req.io, req.user);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry created: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.status(201).json(enquiry);
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Enquiry ID already exists', code: 'DUPLICATE_ENQUIRY_ID' });
    logger.error(`Error creating enquiry: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.getAll = async (req, res) => {
  const { limit = 10, offset = 0, force_refresh = 'false', cursor = null, search = '' } = req.query;
  const parsedLimit = parseInt(limit, 10) || 10;
  const parsedOffset = parseInt(offset, 10) || 0;
  const trimmedSearch = (search || '').trim();
  const cacheKey = `enquiry_list_${req.user.user_id}_${parsedLimit}_${parsedOffset}_${trimmedSearch || 'all'}`;
  try {
    if (force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const enquiries = await Enquiry.getAll({ limit: parsedLimit, offset: parsedOffset, cursor: cursor || null, user: req.user, search: trimmedSearch || null });
    await redis.setEx(cacheKey, 300, JSON.stringify(enquiries));
    res.json(enquiries);
  } catch (error) {
    logger.error(`Error fetching enquiries: ${error.message}`, error.stack);
    res.status(500).json({ error: 'Internal Server Error', code: 'SERVER_ERROR' });
  }
};

exports.getOne = async (req, res) => {
  const cacheKey = `enquiry_${req.user.user_id}_${req.params.id}`;
  try {
    if (req.query.force_refresh === 'true') await redis.del(cacheKey);
    const cached = await redis.get(cacheKey);
    if (cached && req.query.force_refresh !== 'true') { logger.info(`Cache hit for ${cacheKey}`); return res.json(JSON.parse(cached)); }
    const enquiry = await Enquiry.getById(req.params.id, req.user);
    await redis.setEx(cacheKey, 300, JSON.stringify(enquiry));
    res.json(enquiry);
  } catch (error) {
    logger.error(`Error fetching enquiry ${req.params.id}: ${error.message}`, error.stack);
    if (error.message === 'Forbidden') return res.status(403).json({ error: 'You do not have access to this enquiry', code: 'FORBIDDEN' });
    const status = error.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: error.message, code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
};

exports.update = async (req, res) => {
  try {
    const { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date } = req.body;
    const enquiry = await Enquiry.update(req.params.id, { company_name, contact_person, mail_id, phone_no, items_required, status, last_discussion, next_interaction, lead, priority, source, application, tags, due_date }, req.io);
    await deleteByPattern(`enquiry_*_${req.params.id}`);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry updated: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json(enquiry);
  } catch (error) {
    logger.error(`Error updating enquiry ${req.params.id}: ${error.message}`, error.stack);
    const status = error.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: error.message, code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
};

exports.delete = async (req, res) => {
  try {
    const enquiry = await Enquiry.delete(req.params.id, req.io);
    await deleteByPattern(`enquiry_*_${req.params.id}`);
    await deleteByPattern('enquiry_list_*');
    logger.info(`Enquiry deleted: ${enquiry.enquiry_id} by ${req.user.user_id}`);
    res.json({ message: 'Enquiry deleted successfully', enquiry });
  } catch (error) {
    logger.error(`Error deleting enquiry ${req.params.id}: ${error.message}`, error.stack);
    const status = error.message === 'Enquiry not found' ? 404 : 500;
    res.status(status).json({ error: error.message, code: status === 404 ? 'NOT_FOUND' : 'SERVER_ERROR' });
  }
};

exports.assign = async (req, res) => {
  const { assigned_to, due_date, message } = req.body;
  if (!assigned_to) return res.status(400).json({ error: 'assigned_to is required', code: 'INVALID_INPUT' });
  try {
    const enquiry = await Enquiry.assign(req.params.id, { assigned_to: parseInt(assigned_to, 10), due_date, message }, req.io, req.user);
    await deleteByPattern(`enquiry_*_${req.params.id}`);
    await deleteByPattern('enquiry_list_*');
    res.json(enquiry);
  } catch (err) {
    logger.error('Assign enquiry error:', err);
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message });
  }
};

exports.markDone = async (req, res) => {
  try {
    const enquiryId = req.params.id;
    const user = req.user;
    if (!String(user.role_name || '').toLowerCase().includes('design')) {
      return res.status(403).json({ error: 'Only Design role can mark enquiry as done' });
    }
    const SALES_USER_ID = process.env.DEFAULT_SALES_USER_ID ? parseInt(process.env.DEFAULT_SALES_USER_ID, 10) : 7;
    const chk = await pool.query('SELECT assigned_to FROM enquiries WHERE enquiry_id = $1', [enquiryId]);
    if (chk.rows.length === 0) return res.status(404).json({ error: 'Enquiry not found' });
    if (chk.rows[0].assigned_to !== user.user_id) return res.status(403).json({ error: 'You are not the current assignee' });
    const updated = await Enquiry.markDone(enquiryId, user, SALES_USER_ID, req.io);
    await deleteByPattern(`enquiry_*_${enquiryId}`);
    await deleteByPattern('enquiry_list_*');
    if (req.io) req.io.emit('enquiryUpdate', { ...updated, type: 'assigned' });
    res.json(updated);
  } catch (err) {
    logger.error('Mark done error:', err);
    res.status(err.message.includes('not found') ? 404 : 400).json({ error: err.message || 'Failed to mark done' });
  }
};

exports.addComment = async (req, res) => {
  const { message, mentions = [], expected_by, is_internal = false } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required', code: 'INVALID_INPUT' });
  try {
    const activity = await Enquiry.addComment(req.params.id, { message: message.trim(), mentions: Array.isArray(mentions) ? mentions : [], expected_by, is_internal }, req.io, req.user);
    res.json(activity);
  } catch (err) {
    logger.error('Add comment error:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.changeStage = async (req, res) => {
  const { stage, note } = req.body;
  const validStages = ['closed_won', 'closed_lost', 'regret', 'in_discussion', 'design_review', 'admin_review'];
  if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  try {
    const enquiry = await Enquiry.changeStage(req.params.id, { stage, note }, req.io, req.user);
    await deleteByPattern(`enquiry_*_${req.params.id}`);
    await deleteByPattern('enquiry_list_*');
    res.json(enquiry);
  } catch (err) {
    logger.error('Change stage error:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.follow = async (req, res) => {
  try {
    await pool.query('INSERT INTO enquiry_watchers (enquiry_id, user_id) VALUES ($1, $2) ON CONFLICT (enquiry_id, user_id) DO NOTHING', [req.params.id, req.user.user_id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('Follow enquiry error:', err);
    res.status(500).json({ error: 'Failed' });
  }
};

exports.unfollow = async (req, res) => {
  try {
    await pool.query('DELETE FROM enquiry_watchers WHERE enquiry_id = $1 AND user_id = $2', [req.params.id, req.user.user_id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('Unfollow enquiry error:', err);
    res.status(500).json({ error: 'Failed' });
  }
};

exports.markActivityRead = async (req, res) => {
  try {
    await pool.query('INSERT INTO enquiry_read_receipts (activity_id, user_id) VALUES ($1, $2) ON CONFLICT (activity_id, user_id) DO UPDATE SET read_at = NOW()', [req.params.activityId, req.user.user_id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('Mark activity read error:', err);
    res.status(500).json({ error: 'Failed' });
  }
};
