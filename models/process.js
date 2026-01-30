const logger = require('../utils/logger');
const redis = require('../config/redis');

class Process {
  static async getOrders() {
    const pool = require('../config/db');
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
      return instanceGroup;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating instance group for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

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

      if (!component_name || !product_type) throw new Error('component_name and product_type required');
      if (!['Motor', 'Non-Motor'].includes(product_type)) {
        throw new Error('product_type must be Motor or Non-Motor');
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
      return component;
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

      if (!process_name || sequence == null) throw new Error('process_name and sequence required');
      if (!Number.isInteger(sequence) || sequence < 0) {
        throw new Error('sequence must be non-negative integer');
      }

      const { rows: [component] } = await client.query(
        'SELECT component_id FROM components WHERE component_id = $1',
        [component_id]
      );
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
        io.emit('componentProcessUpdate', process);
      }

      await client.query('COMMIT');
      return process;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating process for component ${component_id}: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async createWorkOrder(order_id, { instance_group_id, target_date }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderIdNum = parseInt(order_id, 10);
      if (isNaN(orderIdNum)) throw new Error('Invalid order_id: must be a valid number');

      const { rows: [order] } = await client.query('SELECT order_id FROM orders WHERE order_id = $1', [orderIdNum]);
      if (!order) throw new Error(`Order ${orderIdNum} not found`);

      if (instance_group_id) {
        const instanceGroupIdNum = parseInt(instance_group_id, 10);
        if (isNaN(instanceGroupIdNum)) throw new Error('Invalid instance_group_id: must be a valid number');
        
        const { rows: [ig] } = await client.query(
          'SELECT 1 FROM instance_groups WHERE instance_group_id = $1 AND order_id = $2',
          [instanceGroupIdNum, orderIdNum]
        );
        if (!ig) throw new Error(`Instance group ${instanceGroupIdNum} not found for this order`);
      }

      const { rows: [workOrder] } = await client.query(
        `INSERT INTO work_orders (order_id, instance_group_id, target_date, status)
         VALUES ($1, $2, $3, 'Pending')
         RETURNING work_order_id, order_id, instance_group_id, target_date, status, 
                   TO_CHAR(created_at, 'YYYY-MM-DD') AS created_at`,
        [orderIdNum, instance_group_id ? parseInt(instance_group_id, 10) : null, target_date || null]
      );

      if (io) {
        io.emit('workOrderCreated', workOrder);
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

  static async createWorkOrderComponent(work_order_id, { component_id, quantity }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const workOrderIdNum = parseInt(work_order_id, 10);
      const componentIdNum = parseInt(component_id, 10);
      const quantityNum = parseInt(quantity, 10);

      if (isNaN(workOrderIdNum)) throw new Error('Invalid work_order_id: must be a valid number');
      if (isNaN(componentIdNum)) throw new Error('Invalid component_id: must be a valid number');
      if (isNaN(quantityNum) || quantityNum <= 0) throw new Error('quantity must be a positive integer');

      const { rows: [wo] } = await client.query(
        'SELECT work_order_id, order_id, status FROM work_orders WHERE work_order_id = $1',
        [workOrderIdNum]
      );
      if (!wo) throw new Error(`Work order ${workOrderIdNum} not found`);

      const { rows: [comp] } = await client.query(
        'SELECT component_id, product_type FROM components WHERE component_id = $1',
        [componentIdNum]
      );
      if (!comp) throw new Error(`Component ${componentIdNum} not found`);

      const result = await client.query(
        `INSERT INTO work_order_components (work_order_id, component_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (work_order_id, component_id) DO NOTHING
         RETURNING work_order_component_id, work_order_id, component_id, quantity`,
        [workOrderIdNum, componentIdNum, quantityNum]
      );
      const woc = result.rows[0];

      if (!woc) {
        throw new Error(`Component ${componentIdNum} already added to work order ${workOrderIdNum}`);
      }

      if (comp.product_type === 'Motor') {
        const { rows: processes } = await client.query(
          `SELECT process_id FROM component_processes WHERE component_id = $1 ORDER BY sequence`,
          [componentIdNum]
        );

        for (const process of processes) {
          await client.query(
            `INSERT INTO process_status (work_order_component_id, process_id, status, completed_quantity, in_use_quantity, allowed_quantity)
             VALUES ($1, $2, 'Pending', 0, 0, 0)
             ON CONFLICT (work_order_component_id, process_id) DO NOTHING`,
            [woc.work_order_component_id, process.process_id]
          );
        }
      }

      if (io) {
        io.emit('workOrderComponentAdded', {
          workOrderComponentId: woc.work_order_component_id,
          workOrderId: woc.work_order_id,
          componentId: woc.component_id,
          quantity: woc.quantity
        });
      }

      await client.query('COMMIT');
      return {
        workOrderComponentId: woc.work_order_component_id,
        workOrderId: woc.work_order_id,
        componentId: woc.component_id,
        quantity: woc.quantity
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error creating work order component: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async getAll({ order_id, instance_group_id, limit = 10, cursor, responsible_person, overdue }) {
    const pool = require('../config/db');
    try {
      const conditions = ['wo.order_id = $1'];
      const params = [order_id];
      let idx = 2;

      if (instance_group_id) {
        conditions.push(`wo.instance_group_id = $${idx++}`);
        params.push(instance_group_id);
      }

      if (cursor) {
        conditions.push(`wo.created_at < $${idx++}`);
        params.push(cursor);
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const totalConditions = [`wo2.order_id = $1`];
      const totalParams = [order_id];
      let totalIdx = 2;
      if (instance_group_id) {
        totalConditions.push(`wo2.instance_group_id = $${totalIdx++}`);
        totalParams.push(instance_group_id);
      }

      const totalWhere = totalConditions.length ? `WHERE ${totalConditions.join(' AND ')}` : '';

      const query = `
        SELECT 
          wo.work_order_id,
          wo.order_id,
          wo.instance_group_id,
          ig.instance_name,
          ig.instance_type,
          wo.target_date,
          wo.status,
          TO_CHAR(wo.created_at, 'YYYY-MM-DD') AS created_at,
          wo.created_at AS created_at_ts,
          
          json_agg(
            json_build_object(
              'workOrderComponentId',  woc.work_order_component_id,
              'componentId',           woc.component_id,
              'componentName',         c.component_name,
              'productType',           c.product_type,
              'quantity',              woc.quantity,
              
              'processes', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'processId',               cp.process_id,
                    'processName',             cp.process_name,
                    'sequence',                cp.sequence,
                    'responsiblePerson',       COALESCE(ps.responsible_person, cp.responsible_person),
                    'description',             cp.description,
                    'status',                  ps.status,
                    'completedQuantity',       ps.completed_quantity,
                    'inUseQuantity',           ps.in_use_quantity,
                    'allowedQuantity',         ps.allowed_quantity,
                    'completionDate',          TO_CHAR(ps.completion_date, 'YYYY-MM-DD'),
                    'materialsUsed',           COALESCE((
                      SELECT json_agg(
                        json_build_object(
                          'rawMaterialId',   pmu.raw_material_id,
                          'usedQuantity',    pmu.used_quantity
                        )
                      )
                      FROM process_material_usage pmu
                      WHERE pmu.work_order_component_id = woc.work_order_component_id
                        AND pmu.process_id = cp.process_id
                    ), '[]'::json)
                  ) ORDER BY cp.sequence
                )
                FROM component_processes cp
                LEFT JOIN process_status ps 
                  ON ps.work_order_component_id = woc.work_order_component_id
                 AND ps.process_id = cp.process_id
                WHERE cp.component_id = c.component_id
              ), '[]'::json),
              
              'materials', COALESCE((
                SELECT json_agg(
                  json_build_object(
                    'workOrderMaterialId', wom.work_order_material_id,
                    'rawMaterialId',       wom.raw_material_id,
                    'rawMaterialName',     rm.product_name,
                    'quantity',            wom.quantity
                  )
                )
                FROM work_order_materials wom
                JOIN raw_materials rm ON rm.product_id = wom.raw_material_id
                WHERE wom.work_order_component_id = woc.work_order_component_id
              ), '[]'::json)
            )
          ) FILTER (WHERE woc.work_order_component_id IS NOT NULL) AS components,

          COALESCE((
            SELECT json_agg(
              json_build_object(
                'stageName', wos.stage_name,
                'stageDate', TO_CHAR(wos.stage_date, 'YYYY-MM-DD')
              )
              ORDER BY
                CASE wos.stage_name
                  WHEN 'Assembly' THEN 1
                  WHEN 'Testing'  THEN 2
                  WHEN 'PDI'      THEN 3
                  WHEN 'Packing'  THEN 4
                  WHEN 'Dispatch' THEN 5
                END
            )
            FROM work_order_stages wos
            WHERE wos.work_order_id = wo.work_order_id
          ), '[]'::json) AS stages,
          
          (SELECT COUNT(DISTINCT wo2.work_order_id)
           FROM work_orders wo2
           ${totalWhere}
          ) AS total
          
        FROM work_orders wo
        LEFT JOIN instance_groups      ig  ON wo.instance_group_id  = ig.instance_group_id
        LEFT JOIN work_order_components woc ON woc.work_order_id     = wo.work_order_id
        LEFT JOIN components           c   ON woc.component_id       = c.component_id
        ${whereClause}
        GROUP BY wo.work_order_id, ig.instance_group_id, ig.instance_name, ig.instance_type
        ORDER BY wo.created_at DESC
        LIMIT $${idx}
      `;

      params.push(limit);

      const { rows } = await pool.query(query, params);

      const formatted = rows.map(row => ({
        workOrderId: row.work_order_id,
        orderId: row.order_id,
        instanceGroupId: row.instance_group_id,
        instanceName: row.instance_name,
        instanceType: row.instance_type,
        targetDate: row.target_date ? row.target_date.toISOString().split('T')[0] : null,
        status: row.status,
        createdAt: row.created_at,
        stages: row.stages ?? [],
        components: row.components ?? [],
        total: parseInt(row.total, 10) || 0
      }));

      const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at_ts : null;

      return { data: formatted, total: formatted[0]?.total ?? 0, nextCursor };
    } catch (error) {
      logger.error(`Error in getAll work orders for order ${order_id}: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  /**
   * Updated logic:
   * - in_use_quantity is GLOBAL (sum across all processes ≤ total material)
   * - completed_quantity is LOCAL (each process can complete up to total material independently)
   * - Status: "In Progress" if in_use > 0, "Completed" if completed >= total material, else "Pending"
   */
  static async updateProcessStatus(work_order_component_id, { process_id, completed_quantity, in_use_quantity, completion_date, responsible_person }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const wocId = parseInt(work_order_component_id, 10);
      const procId = parseInt(process_id, 10);

      if (isNaN(wocId) || isNaN(procId)) {
        throw new Error('Invalid IDs');
      }

      // Get total material quantity
      const { rows: [info] } = await client.query(`
        SELECT 
          woc.quantity AS target_qty,
          c.product_type,
          COALESCE(SUM(wom.quantity), 0) AS total_material_qty
        FROM work_order_components woc
        JOIN components c ON c.component_id = woc.component_id
        LEFT JOIN work_order_materials wom ON wom.work_order_component_id = woc.work_order_component_id
        WHERE woc.work_order_component_id = $1
        GROUP BY woc.work_order_component_id, c.product_type, woc.quantity
      `, [wocId]);

      if (!info) throw new Error(`Work order component ${wocId} not found`);
      if (info.product_type !== 'Motor') {
        throw new Error('Processes are only applicable to Motor components');
      }

      const totalMaterial = parseInt(info.total_material_qty, 10);

      // Get current in-use across ALL processes
      const { rows: currentInUseRows } = await client.query(`
        SELECT process_id, in_use_quantity
        FROM process_status
        WHERE work_order_component_id = $1
      `, [wocId]);

      const currentInUseMap = new Map(
        currentInUseRows.map(r => [parseInt(r.process_id), parseInt(r.in_use_quantity)])
      );

      // Get current values for this specific process
      const { rows: [current] } = await client.query(`
        SELECT completed_quantity, in_use_quantity
        FROM process_status
        WHERE work_order_component_id = $1 AND process_id = $2
      `, [wocId, procId]);

      const currCompleted = current ? parseInt(current.completed_quantity) : 0;
      const currInUse     = current ? parseInt(current.in_use_quantity)     : 0;

      const newCompleted = completed_quantity !== undefined ? parseInt(completed_quantity) : currCompleted;
      const newInUse     = in_use_quantity     !== undefined ? parseInt(in_use_quantity)     : currInUse;

      // GLOBAL IN-USE VALIDATION: sum of all in-use must not exceed total material
      let otherInUseSum = 0;
      for (const [pid, qty] of currentInUseMap) {
        if (pid !== procId) otherInUseSum += qty;
      }

      const proposedTotalInUse = otherInUseSum + newInUse;

      if (proposedTotalInUse > totalMaterial) {
        throw new Error(
          `Global in-use capacity exceeded. ` +
          `Total in-use would be ${proposedTotalInUse} but only ${totalMaterial} material available. ` +
          `Other processes are using ${otherInUseSum}.`
        );
      }

      // LOCAL COMPLETED VALIDATION: can't exceed total material
      if (newCompleted > totalMaterial) {
        throw new Error(
          `Completed quantity (${newCompleted}) cannot exceed total material (${totalMaterial})`
        );
      }

      // Prepare update
      const updates = [];
      const values = [];
      let paramIdx = 1;

      if (completed_quantity !== undefined) {
        updates.push(`completed_quantity = $${paramIdx++}`);
        values.push(newCompleted);
      }
      if (in_use_quantity !== undefined) {
        updates.push(`in_use_quantity = $${paramIdx++}`);
        values.push(newInUse);
      }
      if (completion_date !== undefined) {
        updates.push(`completion_date = $${paramIdx++}`);
        values.push(completion_date || null);
      }
      if (responsible_person !== undefined) {
        updates.push(`responsible_person = $${paramIdx++}`);
        values.push(responsible_person);
      }

      // Auto status calculation
      let status = 'Pending';
      if (newCompleted >= totalMaterial) {
        status = 'Completed';
      } else if (newInUse > 0) {
        status = 'In Progress';
      }

      updates.push(`status = $${paramIdx++}`);
      values.push(status);

      values.push(wocId, procId);

      const { rows: [updated] } = await client.query(`
        UPDATE process_status
        SET ${updates.join(', ')}
        WHERE work_order_component_id = $${paramIdx++} 
          AND process_id = $${paramIdx}
        RETURNING 
          status_id, work_order_component_id, process_id, status,
          completed_quantity, in_use_quantity, 
          TO_CHAR(completion_date, 'YYYY-MM-DD') AS completion_date,
          responsible_person, allowed_quantity
      `, values);

      // Update work order overall status
      const { rows: statuses } = await client.query(`
        SELECT ps.status
        FROM process_status ps
        JOIN work_order_components woc ON woc.work_order_component_id = ps.work_order_component_id
        WHERE woc.work_order_id = (SELECT work_order_id FROM work_order_components WHERE work_order_component_id = $1)
      `, [wocId]);

      const allCompleted = statuses.every(s => s.status === 'Completed');
      const hasProgress  = statuses.some(s => s.status === 'In Progress' || s.status === 'Completed');

      let woStatus = 'Pending';
      if (allCompleted) woStatus = 'Completed';
      else if (hasProgress) woStatus = 'In Progress';

      await client.query(
        'UPDATE work_orders SET status = $1 WHERE work_order_id = (SELECT work_order_id FROM work_order_components WHERE work_order_component_id = $2)',
        [woStatus, wocId]
      );

      // Update allowed_quantity informational field
      await client.query(
        `UPDATE process_status
         SET allowed_quantity = $1
         WHERE work_order_component_id = $2`,
        [totalMaterial, wocId]
      );

      if (io) {
        io.emit('processStatusUpdated', {
          ...updated,
          workOrderComponentId: wocId
        });
      }

      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating process status: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async createWorkOrderMaterial(work_order_component_id, { raw_material_id, quantity }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const wocId = parseInt(work_order_component_id, 10);
      const rmId  = parseInt(raw_material_id, 10);
      const qty   = parseInt(quantity, 10);

      if (isNaN(wocId) || isNaN(rmId) || isNaN(qty) || qty < 0) {
        throw new Error('Invalid input values');
      }

      const { rows: [info] } = await client.query(`
        SELECT woc.work_order_id, woc.component_id, c.product_type
        FROM work_order_components woc
        JOIN components c ON c.component_id = woc.component_id
        WHERE woc.work_order_component_id = $1
      `, [wocId]);

      if (!info) throw new Error(`Work order component not found`);
      if (info.product_type !== 'Motor') {
        throw new Error('Materials can only be assigned to Motor components');
      }

      const { rows: [rmExists] } = await client.query(
        'SELECT 1 FROM raw_materials WHERE product_id = $1',
        [rmId]
      );
      if (!rmExists) throw new Error(`Raw material ${rmId} not found`);

      const { rows: [material] } = await client.query(`
        INSERT INTO work_order_materials 
          (work_order_component_id, work_order_id, component_id, raw_material_id, quantity)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (work_order_component_id, raw_material_id)
        DO UPDATE SET quantity = EXCLUDED.quantity
        RETURNING work_order_material_id, work_order_component_id, raw_material_id, quantity
      `, [wocId, info.work_order_id, info.component_id, rmId, qty]);

      // Calculate new total material
      const { rows: [{ total_material }] } = await client.query(`
        SELECT COALESCE(SUM(quantity), 0) AS total_material
        FROM work_order_materials
        WHERE work_order_component_id = $1
      `, [wocId]);

      const newTotal = parseInt(total_material, 10);

      // Check global in-use consistency - if total in-use exceeds new material, reduce proportionally
      const { rows: inUseRows } = await client.query(`
        SELECT SUM(in_use_quantity) AS total_in_use
        FROM process_status
        WHERE work_order_component_id = $1
      `, [wocId]);

      const currentInUse = parseInt(inUseRows[0]?.total_in_use || 0, 10);

      if (currentInUse > newTotal) {
        const reductionFactor = newTotal / currentInUse;
        await client.query(`
          UPDATE process_status
          SET in_use_quantity = FLOOR(in_use_quantity * $1)::int,
              status = CASE 
                WHEN FLOOR(in_use_quantity * $1)::int > 0 THEN 'In Progress'
                WHEN completed_quantity >= $2 THEN 'Completed'
                ELSE 'Pending'
              END
          WHERE work_order_component_id = $3
        `, [reductionFactor, newTotal, wocId]);

        logger.warn(`Auto-reduced in-use quantities due to material reduction (woc=${wocId})`);
      }

      // Update allowed_quantity informational field
      await client.query(
        `UPDATE process_status 
         SET allowed_quantity = $1 
         WHERE work_order_component_id = $2`,
        [newTotal, wocId]
      );

      if (io) {
        io.emit('workOrderMaterialUpdate', {
          ...material,
          totalMaterial: newTotal
        });
      }

      await client.query('COMMIT');
      return {
        workOrderMaterialId: material.work_order_material_id,
        workOrderComponentId: material.work_order_component_id,
        rawMaterialId: material.raw_material_id,
        quantity: material.quantity,
        currentTotalMaterial: newTotal
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error assigning material: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async upsertProcessMaterialUsage(work_order_component_id, process_id, raw_material_id, used_quantity) {
    const pool = require('../config/db');

    const wocIdNum = parseInt(work_order_component_id, 10);
    const processIdNum = parseInt(process_id, 10);
    const rawMaterialIdNum = parseInt(raw_material_id, 10);
    const usedQuantityNum = parseInt(used_quantity, 10);

    if (isNaN(wocIdNum) || isNaN(processIdNum) || isNaN(rawMaterialIdNum) || isNaN(usedQuantityNum) || usedQuantityNum < 0) {
      throw new Error('Invalid input');
    }

    const { rows: [valid] } = await pool.query(
      `SELECT c.product_type
       FROM work_order_components woc
       JOIN component_processes cp ON cp.component_id = woc.component_id
       JOIN components c ON c.component_id = woc.component_id
       WHERE woc.work_order_component_id = $1 AND cp.process_id = $2`,
      [wocIdNum, processIdNum]
    );

    if (!valid || valid.product_type !== 'Motor') {
      throw new Error('Material usage only allowed for Motor component processes');
    }

    const { rows: [row] } = await pool.query(
      `INSERT INTO process_material_usage
         (work_order_component_id, process_id, raw_material_id, used_quantity)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (work_order_component_id, process_id, raw_material_id)
       DO UPDATE SET used_quantity = EXCLUDED.used_quantity
       RETURNING work_order_component_id, process_id, raw_material_id, used_quantity`,
      [wocIdNum, processIdNum, rawMaterialIdNum, usedQuantityNum]
    );

    try {
      const { rows: [{ order_id }] } = await pool.query(
        'SELECT order_id FROM work_orders wo JOIN work_order_components woc ON woc.work_order_id = wo.work_order_id WHERE woc.work_order_component_id = $1',
        [wocIdNum]
      );
      if (order_id) await redis.del(`processes:order:${order_id}`);
    } catch (e) {
      logger.warn('Redis invalidation failed', e);
    }

    return row;
  }

  static async getProcessMaterialUsage(work_order_component_id) {
    const pool = require('../config/db');
    const wocIdNum = parseInt(work_order_component_id, 10);
    if (isNaN(wocIdNum)) throw new Error('Invalid work_order_component_id');

    const { rows } = await pool.query(
      `SELECT 
         pmu.process_id,
         pmu.raw_material_id,
         rm.product_name AS raw_material_name,
         pmu.used_quantity
       FROM process_material_usage pmu
       JOIN raw_materials rm ON rm.product_id = pmu.raw_material_id
       WHERE pmu.work_order_component_id = $1
       ORDER BY pmu.process_id, rm.product_name`,
      [wocIdNum]
    );
    return rows;
  }

  // ────────────────────────────────────────────────
  //           NEW FUNCTIONS ADDED
  // ────────────────────────────────────────────────

  static async updateWorkOrderStage(work_order_id, { stage_name, stage_date }, io) {
    const pool = require('../config/db');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const workOrderIdNum = parseInt(work_order_id, 10);
      if (isNaN(workOrderIdNum)) throw new Error('Invalid work_order_id');

      if (!['Assembly', 'Testing', 'PDI', 'Packing', 'Dispatch'].includes(stage_name)) {
        throw new Error('Invalid stage_name');
      }

      const { rows: [wo] } = await client.query(
        'SELECT work_order_id FROM work_orders WHERE work_order_id = $1',
        [workOrderIdNum]
      );
      if (!wo) throw new Error(`Work order ${workOrderIdNum} not found`);

      const { rows: [stage] } = await client.query(
        `
        UPDATE work_order_stages
        SET stage_date = $3
        WHERE work_order_id = $1
          AND stage_name = $2
        RETURNING 
          work_order_stage_id,
          work_order_id,
          stage_name,
          TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date
        `,
        [workOrderIdNum, stage_name, stage_date || null]
      );

      if (!stage) {
        throw new Error(`Stage ${stage_name} not found for work order ${workOrderIdNum}`);
      }

      if (io) {
        io.emit('workOrderStageUpdate', stage);
      }

      await client.query('COMMIT');
      return stage;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating work order stage: ${error.message}`, { stack: error.stack });
      throw error;
    } finally {
      client.release();
    }
  }

  static async getWorkOrderStages(work_order_id) {
    const pool = require('../config/db');

    const workOrderIdNum = parseInt(work_order_id, 10);
    if (isNaN(workOrderIdNum)) throw new Error('Invalid work_order_id');

    const { rows } = await pool.query(
      `
      SELECT 
        stage_name,
        TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date
      FROM work_order_stages
      WHERE work_order_id = $1
      ORDER BY
        CASE stage_name
          WHEN 'Assembly' THEN 1
          WHEN 'Testing'  THEN 2
          WHEN 'PDI'      THEN 3
          WHEN 'Packing'  THEN 4
          WHEN 'Dispatch' THEN 5
        END
      `,
      [workOrderIdNum]
    );

    return rows;
  }
}

module.exports = Process;