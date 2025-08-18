const pool = require('../config/db');
const logger = require('../utils/logger');

class Process {
  // Get all work orders for an order_id with pagination
  static async getAll({ order_id, limit = 10, cursor = null }) {
    const query = `
      SELECT wo.work_order_id, wo.order_id, wo.component_id, c.component_name, wo.quantity, 
             TO_CHAR(wo.target_date, 'YYYY-MM-DD') AS target_date, wo.responsible_person, 
             wo.process_status, wo.motor_stages, wo.status, wo.created_at, c.processes
      FROM work_orders wo
      JOIN components c ON wo.component_id = c.component_id
      WHERE wo.order_id = $1 AND ($2::timestamp IS NULL OR wo.created_at < $2)
      ORDER BY wo.created_at DESC
      LIMIT $3
    `;
    const countQuery = 'SELECT COUNT(*) FROM work_orders WHERE order_id = $1';
    const values = [order_id, cursor, limit];
    try {
      const [result, countResult] = await Promise.all([
        pool.query(query, values),
        pool.query(countQuery, [order_id]),
      ]);
      console.log('Work orders from DB:', result.rows);
      return {
        data: result.rows,
        total: parseInt(countResult.rows[0].count, 10),
        nextCursor: result.rows.length ? result.rows[result.rows.length - 1].created_at : null,
      };
    } catch (error) {
      logger.error(`Error fetching work orders for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  // Get PDI reports for an order_id
  static async getPDIReports(order_id) {
    try {
      const { rows } = await pool.query(
        'SELECT report_id, order_id, report, description, created_at FROM pre_dispatch_inspection_reports WHERE order_id = $1',
        [order_id]
      );
      console.log('PDI reports from DB:', rows);
      return rows;
    } catch (error) {
      logger.error(`Error fetching PDI reports for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  // Create a new work order
  static async create(order_id, component_id, { quantity, target_date, responsible_person, process_status }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Validate component_id and order_id
      const { rows: [component] } = await client.query(
        'SELECT component_id, processes FROM components WHERE component_id = $1',
        [component_id]
      );
      if (!component) throw new Error(`Component ${component_id} not found`);
      const { rows: [order] } = await client.query(
        'SELECT order_id FROM orders WHERE order_id = $1',
        [order_id]
      );
      if (!order) throw new Error(`Order ${order_id} not found`);

      // Initialize process_status if not provided
      const defaultProcessStatus = Object.fromEntries(
        component.processes.map(p => [p.name, { status: 'Pending', completion_date: null }])
      );
      const finalProcessStatus = process_status || defaultProcessStatus;

      const { rows: [workOrder] } = await client.query(
        `INSERT INTO work_orders (order_id, component_id, quantity, target_date, responsible_person, process_status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING work_order_id, order_id, component_id, quantity, TO_CHAR(target_date, 'YYYY-MM-DD') AS target_date, 
                   responsible_person, process_status, motor_stages, status, created_at`,
        [order_id, component_id, quantity, target_date, responsible_person, finalProcessStatus]
      );

      // Emit Socket.IO event
      if (io) {
        io.emit('processUpdate', {
          work_order_id: workOrder.work_order_id,
          order_id: workOrder.order_id,
          component_id: workOrder.component_id,
          process_status: workOrder.process_status,
          status: workOrder.status,
        });
      }

      await client.query('COMMIT');
      return workOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating work order for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // Update process_status for a work order
  static async updateProcessStatus(work_order_id, { process_name, status, completion_date }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [workOrder] } = await client.query(
        'SELECT wo.work_order_id, wo.process_status, c.processes FROM work_orders wo JOIN components c ON wo.component_id = c.component_id WHERE wo.work_order_id = $1',
        [work_order_id]
      );
      if (!workOrder) throw new Error('Work order not found');

      // Validate process_name
      const processExists = workOrder.processes.some(p => p.name === process_name);
      if (!processExists) throw new Error(`Process ${process_name} not found for this component`);

      // Update process_status
      const updatedProcessStatus = {
        ...workOrder.process_status,
        [process_name]: { status, completion_date },
      };

      const { rows: [updatedWorkOrder] } = await client.query(
        `UPDATE work_orders
         SET process_status = $1
         WHERE work_order_id = $2
         RETURNING work_order_id, order_id, component_id, quantity, TO_CHAR(target_date, 'YYYY-MM-DD') AS target_date, 
                   responsible_person, process_status, motor_stages, status, created_at`,
        [updatedProcessStatus, work_order_id]
      );

      // Emit Socket.IO event
      if (io) {
        io.emit('processUpdate', {
          work_order_id: updatedWorkOrder.work_order_id,
          order_id: updatedWorkOrder.order_id,
          component_id: updatedWorkOrder.component_id,
          process_status: updatedWorkOrder.process_status,
          status: updatedWorkOrder.status,
        });
      }

      await client.query('COMMIT');
      return updatedWorkOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating process status for work order ${work_order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // Update motor_stages for Motor Assembly
  static async updateMotorStages(work_order_id, { motor_stages }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [workOrder] } = await client.query(
        'SELECT wo.work_order_id, c.component_name FROM work_orders wo JOIN components c ON wo.component_id = c.component_id WHERE wo.work_order_id = $1',
        [work_order_id]
      );
      if (!workOrder) throw new Error('Work order not found');
      if (workOrder.component_name !== 'Motor Assembly') throw new Error('Motor stages can only be updated for Motor Assembly');

      const { rows: [updatedWorkOrder] } = await client.query(
        `UPDATE work_orders
         SET motor_stages = $1
         WHERE work_order_id = $2
         RETURNING work_order_id, order_id, component_id, quantity, TO_CHAR(target_date, 'YYYY-MM-DD') AS target_date, 
                   responsible_person, process_status, motor_stages, status, created_at`,
        [motor_stages, work_order_id]
      );

      // Emit Socket.IO event
      if (io) {
        io.emit('processUpdate', {
          work_order_id: updatedWorkOrder.work_order_id,
          order_id: updatedWorkOrder.order_id,
          component_id: updatedWorkOrder.component_id,
          motor_stages: updatedWorkOrder.motor_stages,
          status: updatedWorkOrder.status,
        });
      }

      await client.query('COMMIT');
      return updatedWorkOrder;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating motor stages for work order ${work_order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // Create a PDI report
  static async createPDIReport(order_id, { report, description }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [order] } = await client.query('SELECT order_id FROM orders WHERE order_id = $1', [order_id]);
      if (!order) throw new Error(`Order ${order_id} not found`);

      const { rows: [pdiReport] } = await client.query(
        `INSERT INTO pre_dispatch_inspection_reports (order_id, report, description)
         VALUES ($1, $2, $3)
         RETURNING report_id, order_id, report, description, created_at`,
        [order_id, report, description]
      );

      // Emit Socket.IO event
      if (io) {
        io.emit('pdiUpdate', {
          report_id: pdiReport.report_id,
          order_id: pdiReport.order_id,
          report: pdiReport.report,
          description: pdiReport.description,
          created_at: pdiReport.created_at,
        });
      }

      await client.query('COMMIT');
      return pdiReport;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating PDI report for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { Process };