const pool = require('../../config/db');

const ServiceRepair = {
  async getAll({ limit = 20, offset = 0 } = {}) {
    const { rows } = await pool.query(
      `SELECT r.*, u.name AS created_by_name
       FROM service_repair_records r
       LEFT JOIN users u ON r.created_by = u.user_id
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  },

  async getById(record_id) {
    const { rows } = await pool.query(
      `SELECT r.*, u.name AS created_by_name
       FROM service_repair_records r
       LEFT JOIN users u ON r.created_by = u.user_id
       WHERE r.record_id = $1`,
      [record_id]
    );
    return rows[0] || null;
  },

  async create(data, userId) {
    const {
      customer_name, dispatch_material_no, part_details,
      chalan_photo_url, receiving_quantity, dispatch_quantity,
      fault_query, actual_issue, delivery_challan_photo_url,
      repaired_photos_urls, repair_status, responsibility_person,
      testing_responsibility, remarks, sent_date, service_type,
    } = data;

    const { rows } = await pool.query(
      `INSERT INTO service_repair_records (
        customer_name, dispatch_material_no, part_details,
        chalan_photo_url, receiving_quantity, dispatch_quantity,
        fault_query, actual_issue, delivery_challan_photo_url,
        repaired_photos_urls, repair_status, responsibility_person,
        testing_responsibility, remarks, sent_date, service_type, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *`,
      [
        customer_name, dispatch_material_no || null, part_details || null,
        chalan_photo_url || null, receiving_quantity || null, dispatch_quantity || null,
        fault_query || null, actual_issue || null, delivery_challan_photo_url || null,
        repaired_photos_urls || null, repair_status || 'pending',
        responsibility_person || null, testing_responsibility || null,
        remarks || null, sent_date || null, service_type || 'repair', userId,
      ]
    );
    return rows[0];
  },

  async update(record_id, data) {
    const {
      customer_name, dispatch_material_no, part_details,
      chalan_photo_url, receiving_quantity, dispatch_quantity,
      fault_query, actual_issue, delivery_challan_photo_url,
      repaired_photos_urls, repair_status, responsibility_person,
      testing_responsibility, remarks, sent_date, service_type,
    } = data;

    const { rows } = await pool.query(
      `UPDATE service_repair_records SET
        customer_name = $1, dispatch_material_no = $2, part_details = $3,
        chalan_photo_url = $4, receiving_quantity = $5, dispatch_quantity = $6,
        fault_query = $7, actual_issue = $8, delivery_challan_photo_url = $9,
        repaired_photos_urls = $10, repair_status = $11, responsibility_person = $12,
        testing_responsibility = $13, remarks = $14, sent_date = $15, service_type = $16
       WHERE record_id = $17
       RETURNING *`,
      [
        customer_name, dispatch_material_no || null, part_details || null,
        chalan_photo_url || null, receiving_quantity || null, dispatch_quantity || null,
        fault_query || null, actual_issue || null, delivery_challan_photo_url || null,
        repaired_photos_urls || null, repair_status || 'pending',
        responsibility_person || null, testing_responsibility || null,
        remarks || null, sent_date || null, service_type || 'repair', record_id,
      ]
    );
    return rows[0] || null;
  },

  async updatePhotoField(record_id, field, url) {
    const allowed = ['chalan_photo_url', 'delivery_challan_photo_url'];
    if (!allowed.includes(field)) throw new Error('Invalid photo field');
    const { rows } = await pool.query(
      `UPDATE service_repair_records SET ${field} = $1 WHERE record_id = $2 RETURNING *`,
      [url, record_id]
    );
    return rows[0] || null;
  },

  async remove(record_id) {
    const { rowCount } = await pool.query(
      'DELETE FROM service_repair_records WHERE record_id = $1',
      [record_id]
    );
    return rowCount > 0;
  },

  async appendRepairedPhoto(record_id, url) {
    const { rows } = await pool.query(
      `UPDATE service_repair_records
       SET repaired_photos_urls = array_append(COALESCE(repaired_photos_urls, '{}'), $1)
       WHERE record_id = $2
       RETURNING *`,
      [url, record_id]
    );
    return rows[0] || null;
  },
};

module.exports = ServiceRepair;
