const logger = require('../utils/logger');
const redis = require('../config/redis');

class Process {
  static async getOrders() {
    const pool = require('../config/db'); // Import inside method
    if (!pool) {
      logger.error('Database pool is not initialized');
      throw new Error('Database pool is not initialized');
    }
    try {
      const { rows } = await pool.query(
        `SELECT order_id, status, target_delivery_date, TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at 
         FROM orders 
         ORDER BY created_at DESC`
      );
      return rows;
    } catch (error) {
      logger.error(`Error fetching orders: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  static async getInstanceGroups(order_id) {
    const pool = require('../config/db');
    try {
      const { rows } = await pool.query(
        `SELECT instance_group_id, order_id, instance_name, instance_type, 
                TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at 
         FROM instance_groups 
         WHERE order_id = $1 
         ORDER BY instance_name`,
        [order_id]
      );
      return rows.map(row => ({
        instanceGroupId: row.instance_group_id,
        orderId: row.order_id,
        instanceName: row.instance_name,
        instanceType: row.instance_type,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.error(`Error fetching instance groups for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  static async createInstanceGroup(order_id, { instance_name, instance_type }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [order] } = await client.query('SELECT order_id FROM orders WHERE order_id = $1', [order_id]);
      if (!order) throw new Error(`Order ${order_id} not found`);

      if (!['Motor', 'Non-Motor'].includes(instance_type)) {
        throw new Error('Invalid instance_type: must be Motor or Non-Motor');
      }

      const { rows: [instanceGroup] } = await client.query(
        `INSERT INTO instance_groups (order_id, instance_name, instance_type)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT unique_instance_name_per_order
         DO NOTHING
         RETURNING instance_group_id, order_id, instance_name, instance_type, 
                  TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at`,
        [order_id, instance_name, instance_type]
      );

      if (!instanceGroup) throw new Error(`Instance group ${instance_name} already exists for order ${order_id}`);

      if (io) {
        io.emit('instanceGroupUpdate', {
          instanceGroupId: instanceGroup.instance_group_id,
          orderId: instanceGroup.order_id,
          instanceName: instanceGroup.instance_name,
          instanceType: instanceGroup.instance_type,
          createdAt: instanceGroup.created_at
        });
      }

      await client.query('COMMIT');
      return {
        instanceGroupId: instanceGroup.instance_group_id,
        orderId: instanceGroup.order_id,
        instanceName: instanceGroup.instance_name,
        instanceType: instanceGroup.instance_type,
        createdAt: instanceGroup.created_at
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating instance group for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  // Update other methods similarly
  static async getComponents() {
    const pool = require('../config/db');
    try {
      const { rows } = await pool.query(
        `SELECT c.component_id, c.component_name, c.product_type, c.is_fixed,
                COALESCE(
                  (
                    SELECT json_agg(
                      json_build_object(
                        'processId', cp.process_id,
                        'processName', cp.process_name,
                        'sequence', cp.sequence,
                        'responsiblePerson', cp.responsible_person,
                        'description', cp.description
                      ) ORDER BY cp.sequence
                    )
                    FROM component_processes cp
                    WHERE cp.component_id = c.component_id
                  ),
                  '[]'::json
                ) AS processes
         FROM components c
         ORDER BY c.component_name`
      );

      return rows.map(row => ({
        componentId: row.component_id,
        componentName: row.component_name,
        productType: row.product_type,
        isFixed: row.is_fixed,
        processes: row.processes
      }));
    } catch (error) {
      logger.error(`Error fetching components: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  static async createComponent({ component_name, product_type }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!component_name || !product_type) {
        throw new Error('Invalid input: component_name and product_type required');
      }
      if (!['Motor', 'Non-Motor'].includes(product_type)) {
        throw new Error('Invalid product_type: must be Motor or Non-Motor');
      }

      const { rows: [component] } = await client.query(
        `INSERT INTO components (component_name, product_type)
         VALUES ($1, $2)
         ON CONFLICT ON CONSTRAINT unique_component_name
         DO NOTHING
         RETURNING component_id, component_name, product_type, is_fixed, 
                  TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at`,
        [component_name, product_type]
      );

      if (!component) throw new Error(`Component ${component_name} already exists`);

      if (io) {
        io.emit('componentUpdate', {
          componentId: component.component_id,
          componentName: component.component_name,
          productType: component.product_type,
          isFixed: component.is_fixed,
          createdAt: component.created_at
        });
      }

      await client.query('COMMIT');
      return {
        componentId: component.component_id,
        componentName: component.component_name,
        productType: component.product_type,
        isFixed: component.is_fixed,
        createdAt: component.created_at
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating component ${component_name}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async createComponentProcess(component_id, { process_name, sequence, responsible_person, description }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!process_name || sequence == null) {
        throw new Error('Invalid input: process_name and sequence required');
      }
      if (!Number.isInteger(sequence) || sequence < 0) {
        throw new Error('Invalid sequence: must be a non-negative integer');
      }

      const { rows: [component] } = await client.query('SELECT component_id FROM components WHERE component_id = $1', [component_id]);
      if (!component) throw new Error(`Component ${component_id} not found`);

      const { rows: [process] } = await client.query(
        `INSERT INTO component_processes (component_id, process_name, sequence, responsible_person, description)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT unique_process_per_component
         DO NOTHING
         RETURNING process_id, component_id, process_name, sequence, responsible_person, description`,
        [component_id, process_name, sequence, responsible_person || null, description || null]
      );

      if (!process) throw new Error(`Process at sequence ${sequence} already exists for component ${component_id}`);

      if (io) {
        io.emit('componentProcessUpdate', {
          processId: process.process_id,
          componentId: process.component_id,
          processName: process.process_name,
          sequence: process.sequence,
          responsiblePerson: process.responsible_person,
          description: process.description
        });
      }

      await client.query('COMMIT');
      return {
        processId: process.process_id,
        componentId: process.component_id,
        processName: process.process_name,
        sequence: process.sequence,
        responsiblePerson: process.responsible_person,
        description: process.description
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating process for component ${component_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async createComponentRawMaterial(component_id, { raw_material_id, quantity_per_unit }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!raw_material_id || quantity_per_unit == null) {
        throw new Error('Invalid input: raw_material_id and quantity_per_unit required');
      }
      if (!Number.isInteger(quantity_per_unit) || quantity_per_unit < 0) {
        throw new Error('Invalid quantity_per_unit: must be a non-negative integer');
      }

      const { rows: [component] } = await client.query('SELECT component_id FROM components WHERE component_id = $1', [component_id]);
      if (!component) throw new Error(`Component ${component_id} not found`);

      const { rows: [rawMaterial] } = await client.query('SELECT product_id FROM raw_materials WHERE product_id = $1', [raw_material_id]);
      if (!rawMaterial) throw new Error(`Raw material ${raw_material_id} not found`);

      const { rows: [material] } = await client.query(
        `INSERT INTO component_raw_materials (component_id, raw_material_id, quantity_per_unit)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT unique_material_per_component
         DO NOTHING
         RETURNING material_id, component_id, raw_material_id, quantity_per_unit`,
        [component_id, raw_material_id, quantity_per_unit]
      );

      if (!material) throw new Error(`Material ${raw_material_id} already assigned to component ${component_id}`);

      if (io) {
        io.emit('componentRawMaterialUpdate', {
          materialId: material.material_id,
          componentId: material.component_id,
          rawMaterialId: material.raw_material_id,
          quantityPerUnit: material.quantity_per_unit
        });
      }

      await client.query('COMMIT');
      return {
        materialId: material.material_id,
        componentId: material.component_id,
        rawMaterialId: material.raw_material_id,
        quantityPerUnit: material.quantity_per_unit
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error assigning raw material to component ${component_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async getAll({ order_id, instance_group_id, limit, cursor, responsible_person, overdue }) {
    const pool = require('../config/db');
    try {
      const conditions = ['wo.order_id = $1'];
      const params = [order_id];
      let paramIndex = 2;

      if (instance_group_id) {
        conditions.push(`wo.instance_group_id = $${paramIndex++}`);
        params.push(instance_group_id);
      }

      if (responsible_person) {
        conditions.push(`cp.responsible_person ILIKE $${paramIndex++}`);
        params.push(`%${responsible_person}%`);
      }

      if (overdue) {
        conditions.push(`wo.target_date < CURRENT_DATE AND (ps.status != 'Completed' OR ps.status IS NULL)`);
      }

      if (cursor) {
        conditions.push(`wo.created_at < $${paramIndex++}`);
        params.push(cursor);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT wo.work_order_id, wo.order_id, wo.component_id, c.component_name, c.product_type, 
               wo.instance_group_id, ig.instance_name, ig.instance_type, wo.quantity, 
               wo.target_date, wo.status, TO_CHAR(wo.created_at, 'YYYY-MM-DD') AS created_at,
               COALESCE(
                 (
                   SELECT json_agg(
                     json_build_object(
                       'processId', cp.process_id,
                       'processName', cp.process_name,
                       'sequence', cp.sequence,
                       'responsiblePerson', cp.responsible_person,
                       'description', cp.description,
                       'status', ps.status,
                       'completedQuantity', ps.completed_quantity,
                       'completionDate', TO_CHAR(ps.completion_date, 'YYYY-MM-DD')
                     ) ORDER BY cp.sequence
                   )
                   FROM component_processes cp
                   LEFT JOIN process_status ps ON cp.process_id = ps.process_id AND ps.work_order_id = wo.work_order_id
                   WHERE cp.component_id = c.component_id
                 ),
                 '[]'::json
               ) AS processes,
               COALESCE(
                 (
                   SELECT json_agg(
                     json_build_object(
                       'workOrderMaterialId', wom.work_order_material_id,
                       'materialId', wom.material_id,
                       'rawMaterialId', crm.raw_material_id,
                       'quantity', wom.quantity
                     )
                   )
                   FROM work_order_materials wom
                   JOIN component_raw_materials crm ON wom.material_id = crm.material_id
                   WHERE wom.work_order_id = wo.work_order_id
                 ),
                 '[]'::json
               ) AS materials,
               COALESCE(
                 (
                   SELECT json_agg(
                     json_build_object(
                       'stageName', os.stage_name,
                       'stageDate', TO_CHAR(os.stage_date, 'YYYY-MM-DD')
                     )
                   )
                   FROM order_stages os
                   WHERE os.order_id = wo.order_id
                 ),
                 '[]'::json
               ) AS order_stages,
               (SELECT COUNT(*) 
                FROM work_orders wo2
                LEFT JOIN instance_groups ig2 ON wo2.instance_group_id = ig2.instance_group_id
                WHERE wo2.order_id = $1
                ${instance_group_id ? `AND wo2.instance_group_id = $${params.indexOf(instance_group_id) + 1}` : ''}) AS total
        FROM work_orders wo
        LEFT JOIN components c ON wo.component_id = c.component_id
        LEFT JOIN instance_groups ig ON wo.instance_group_id = ig.instance_group_id
        LEFT JOIN component_processes cp ON c.component_id = cp.component_id
        LEFT JOIN process_status ps ON cp.process_id = ps.process_id AND ps.work_order_id = wo.work_order_id
        ${whereClause}
        GROUP BY wo.work_order_id, c.component_id, c.component_name, c.product_type, ig.instance_group_id, ig.instance_name, ig.instance_type
        ORDER BY wo.created_at DESC
        LIMIT $${paramIndex}
      `;

      params.push(limit || 10);

      const { rows } = await pool.query(query, params);

      const formattedRows = rows.map(row => ({
        workOrderId: row.work_order_id,
        orderId: row.order_id,
        componentId: row.component_id,
        componentName: row.component_name,
        productType: row.product_type,
        instanceGroupId: row.instance_group_id,
        instanceName: row.instance_name,
        instanceType: row.instance_type,
        quantity: row.quantity,
        targetDate: row.target_date ? row.target_date.toISOString().split('T')[0] : null,
        status: row.status,
        createdAt: row.created_at,
        processes: row.processes.filter(p => p.processId !== null),
        materials: row.materials,
        orderStages: row.order_stages
      }));

      const total = rows.length > 0 ? parseInt(rows[0].total, 10) : 0;
      const nextCursor = rows.length === (limit || 10) ? rows[rows.length - 1].created_at : null;

      return { data: formattedRows, total, nextCursor };
    } catch (error) {
      logger.error(`Error fetching processes for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  static async create(order_id, { component_id, instance_group_id, quantity, target_date }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!component_id || !quantity) throw new Error('Invalid input: component_id and quantity required');
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid quantity: must be a positive integer');

      const { rows: [order] } = await client.query('SELECT order_id FROM orders WHERE order_id = $1', [order_id]);
      if (!order) throw new Error(`Order ${order_id} not found`);

      const { rows: [component] } = await client.query('SELECT component_id FROM components WHERE component_id = $1', [component_id]);
      if (!component) throw new Error(`Component ${component_id} not found`);

      if (instance_group_id) {
        const { rows: [instanceGroup] } = await client.query('SELECT instance_group_id FROM instance_groups WHERE instance_group_id = $1 AND order_id = $2', [instance_group_id, order_id]);
        if (!instanceGroup) throw new Error(`Instance group ${instance_group_id} not found for order ${order_id}`);
      }

      const { rows: [workOrder] } = await client.query(
        `INSERT INTO work_orders (order_id, component_id, instance_group_id, quantity, target_date, status)
         VALUES ($1, $2, $3, $4, $5, 'Pending')
         RETURNING work_order_id, order_id, component_id, instance_group_id, quantity, target_date, status, 
                  TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at`,
        [order_id, component_id, instance_group_id || null, quantity, target_date || null]
      );

      const { rows: processes } = await client.query(
        `SELECT process_id 
         FROM component_processes 
         WHERE component_id = $1 
         ORDER BY sequence`,
        [component_id]
      );

      for (const process of processes) {
        await client.query(
          `INSERT INTO process_status (work_order_id, process_id, status, completed_quantity)
           VALUES ($1, $2, 'Pending', 0)`,
          [workOrder.work_order_id, process.process_id]
        );
      }

      if (io) {
        io.emit('processUpdate', {
          workOrderId: workOrder.work_order_id,
          orderId: workOrder.order_id,
          componentId: workOrder.component_id,
          instanceGroupId: workOrder.instance_group_id,
          quantity: workOrder.quantity,
          targetDate: workOrder.target_date ? workOrder.target_date.toISOString().split('T')[0] : null,
          status: workOrder.status,
          createdAt: workOrder.created_at
        });
      }

      await client.query('COMMIT');
      return {
        workOrderId: workOrder.work_order_id,
        orderId: workOrder.order_id,
        componentId: workOrder.component_id,
        instanceGroupId: workOrder.instance_group_id,
        quantity: workOrder.quantity,
        targetDate: workOrder.target_date ? workOrder.target_date.toISOString().split('T')[0] : null,
        status: workOrder.status,
        createdAt: workOrder.created_at
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating work order for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateProcessStatus(work_order_id, { process_id, status, completed_quantity, completion_date }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!process_id || !status) throw new Error('Invalid input: process_id and status required');
      if (!['Pending', 'In Progress', 'Completed'].includes(status)) {
        throw new Error('Invalid status: must be Pending, In Progress, or Completed');
      }
      if (completed_quantity != null && (!Number.isInteger(completed_quantity) || completed_quantity < 0)) {
        throw new Error('Invalid completed_quantity: must be a non-negative integer');
      }

      const { rows: [workOrder] } = await client.query('SELECT work_order_id, quantity FROM work_orders WHERE work_order_id = $1', [work_order_id]);
      if (!workOrder) throw new Error(`Work order ${work_order_id} not found`);

      if (completed_quantity != null && completed_quantity > workOrder.quantity) {
        throw new Error(`Completed quantity ${completed_quantity} exceeds work order quantity ${workOrder.quantity}`);
      }

      const { rows: [process] } = await client.query('SELECT process_id FROM component_processes WHERE process_id = $1', [process_id]);
      if (!process) throw new Error(`Process ${process_id} not found`);

      const { rows: [statusRecord] } = await client.query(
        `UPDATE process_status
         SET status = $1, completed_quantity = COALESCE($2, completed_quantity), 
             completion_date = CASE WHEN $1 = 'Completed' THEN COALESCE($3, CURRENT_DATE) ELSE completion_date END
         WHERE work_order_id = $4 AND process_id = $5
         RETURNING status_id, work_order_id, process_id, status, completed_quantity, 
                  TO_CHAR(completion_date, 'YYYY-MM-DD') AS completion_date`,
        [status, completed_quantity, completion_date || null, work_order_id, process_id]
      );

      if (!statusRecord) throw new Error(`Process status not found for work order ${work_order_id} and process ${process_id}`);

      if (io) {
        io.emit('processUpdate', {
          statusId: statusRecord.status_id,
          workOrderId: statusRecord.work_order_id,
          processId: statusRecord.process_id,
          status: statusRecord.status,
          completedQuantity: statusRecord.completed_quantity,
          completionDate: statusRecord.completion_date
        });
      }

      await client.query('COMMIT');
      return {
        statusId: statusRecord.status_id,
        workOrderId: statusRecord.work_order_id,
        processId: statusRecord.process_id,
        status: statusRecord.status,
        completedQuantity: statusRecord.completed_quantity,
        completionDate: statusRecord.completion_date
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating process status for work order ${work_order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async updateOrderStage(order_id, { stage_name, stage_date }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!stage_name || !stage_date) throw new Error('Invalid input: stage_name and stage_date required');
      if (!['Assembly', 'Testing', 'Packing', 'Dispatch'].includes(stage_name)) {
        throw new Error('Invalid stage_name: must be Assembly, Testing, Packing, or Dispatch');
      }

      const { rows: [order] } = await client.query('SELECT order_id FROM orders WHERE order_id = $1', [order_id]);
      if (!order) throw new Error(`Order ${order_id} not found`);

      const { rows: [stage] } = await client.query(
        `INSERT INTO order_stages (order_id, stage_name, stage_date)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT unique_stage_per_order
         DO UPDATE SET stage_date = $3
         RETURNING stage_id, order_id, stage_name, TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date`,
        [order_id, stage_name, stage_date]
      );

      if (io) {
        io.emit('orderStageUpdate', {
          stageId: stage.stage_id,
          orderId: stage.order_id,
          stageName: stage.stage_name,
          stageDate: stage.stage_date
        });
      }

      await client.query('COMMIT');
      return {
        stageId: stage.stage_id,
        orderId: stage.order_id,
        stageName: stage.stage_name,
        stageDate: stage.stage_date
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating order stage for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async createWorkOrderMaterial(work_order_id, { material_id, quantity }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!material_id || quantity == null) throw new Error('Invalid input: material_id and quantity required');
      if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Invalid quantity: must be a non-negative integer');

      const { rows: [workOrder] } = await client.query('SELECT work_order_id FROM work_orders WHERE work_order_id = $1', [work_order_id]);
      if (!workOrder) throw new Error(`Work order ${work_order_id} not found`);

      const { rows: [material] } = await client.query('SELECT material_id FROM component_raw_materials WHERE material_id = $1', [material_id]);
      if (!material) throw new Error(`Material ${material_id} not found`);

      const { rows: [workOrderMaterial] } = await client.query(
        `INSERT INTO work_order_materials (work_order_id, material_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT unique_material_per_work_order
         DO UPDATE SET quantity = $3
         RETURNING work_order_material_id, work_order_id, material_id, quantity`,
        [work_order_id, material_id, quantity]
      );

      if (io) {
        io.emit('workOrderMaterialUpdate', {
          workOrderMaterialId: workOrderMaterial.work_order_material_id,
          workOrderId: workOrderMaterial.work_order_id,
          materialId: workOrderMaterial.material_id,
          quantity: workOrderMaterial.quantity
        });
      }

      await client.query('COMMIT');
      return {
        workOrderMaterialId: workOrderMaterial.work_order_material_id,
        workOrderId: workOrderMaterial.work_order_id,
        materialId: workOrderMaterial.material_id,
        quantity: workOrderMaterial.quantity
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating work order material for work order ${work_order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Process;