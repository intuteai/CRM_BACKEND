const express = require('express');
const router = express.Router({ mergeParams: true });
const Process = require('../models/process');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const redis = require('../config/redis');
const pool = require('../config/db');

// Debug: Log pool at module level to verify it's defined
console.log('Pool in processRoutes.js:', pool ? 'Defined' : 'Undefined');

const formatResponse = (workOrder) => ({
  workOrderId: workOrder.workOrderId,
  orderId: workOrder.orderId,
  componentId: workOrder.componentId,
  componentName: workOrder.componentName,
  productType: workOrder.productType,
  instanceGroupId: workOrder.instanceGroupId,
  instanceName: workOrder.instanceName,
  instanceType: workOrder.instanceType,
  quantity: workOrder.quantity,
  targetDate: workOrder.targetDate,
  status: workOrder.status,
  createdAt: workOrder.createdAt,
  processes: workOrder.processes.map(process => ({
    processId: process.processId,
    processName: process.processName,
    sequence: process.sequence,
    responsiblePerson: process.responsiblePerson,
    description: process.description,
    status: process.status,
    completedQuantity: process.completedQuantity,
    rawQuantityUsed: process.rawQuantityUsed,
    completionDate: process.completionDate
  })),
  materials: workOrder.materials.map(material => ({
    workOrderMaterialId: material.workOrderMaterialId,
    materialId: material.materialId,
    rawMaterialId: material.rawMaterialId,
    quantity: material.quantity
  })),
  orderStages: workOrder.orderStages.map(stage => ({
    stageName: stage.stageName,
    stageDate: stage.stageDate
  })),
  timezone: 'Asia/Kolkata'
});

// Helper to calculate total completed quantity for a work order, excluding the current process
async function getTotalCompletedQuantity(workOrderId, processId) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(completed_quantity), 0) as total FROM process_status WHERE work_order_id = $1 AND process_id != $2',
    [workOrderId, processId]
  );
  return parseInt(result.rows[0].total) || 0;
}

router.get('/orders', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  try {
    console.log('Entering /api/process/orders route for user:', req.user.userId);
    console.log('Calling Process.getOrders');
    const orders = await Process.getOrders();
    console.log('Orders fetched from Process.getOrders:', orders);
    const response = orders.map(order => ({
      orderId: order.order_id,
      status: order.status,
      targetDeliveryDate: order.target_delivery_date ? order.target_delivery_date.toISOString().split('T')[0] : null,
      createdAt: order.created_at,
      timezone: 'Asia/Kolkata'
    }));
    console.log('Response to frontend:', response);
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching orders for user ${req.user.userId}: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

router.get('/:orderId/instance-groups', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  const { orderId } = req.params;
  try {
    console.log(`Fetching instance groups for order ${orderId}`);
    const instanceGroups = await Process.getInstanceGroups(orderId);
    console.log('Instance groups fetched:', instanceGroups);
    res.json(instanceGroups);
  } catch (error) {
    logger.error(`Error fetching instance groups for order ${orderId}: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

router.post('/:orderId/instance-groups', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { orderId } = req.params;
  const { instance_name, instance_type } = req.body;
  try {
    if (!instance_name || !instance_type) {
      return res.status(400).json({ error: 'Invalid input: instance_name and instance_type required' });
    }
    console.log(`Creating instance group for order ${orderId}:`, { instance_name, instance_type });
    const instanceGroup = await Process.createInstanceGroup(orderId, { instance_name, instance_type }, req.io);
    console.log('Instance group created:', instanceGroup);
    res.status(201).json(instanceGroup);
  } catch (error) {
    logger.error(`Error creating instance group for order ${orderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/components', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  try {
    console.log('Fetching components');
    const components = await Process.getComponents();
    console.log('Components fetched:', components);
    res.json(components);
  } catch (error) {
    logger.error(`Error fetching components: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

router.post('/components', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { component_name, product_type } = req.body;
  try {
    if (!component_name || !product_type) {
      return res.status(400).json({ error: 'Invalid input: component_name and product_type required' });
    }
    console.log('Creating component:', { component_name, product_type });
    const component = await Process.createComponent({ component_name, product_type }, req.io);
    console.log('Component created:', component);
    res.status(201).json(component);
  } catch (error) {
    logger.error(`Error creating component ${component_name}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.post('/components/:componentId/processes', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { componentId } = req.params;
  const { process_name, sequence, responsible_person, description } = req.body;
  try {
    if (!process_name || sequence == null) {
      return res.status(400).json({ error: 'Invalid input: process_name and sequence required' });
    }
    console.log(`Creating process for component ${componentId}:`, { process_name, sequence });
    const process = await Process.createComponentProcess(componentId, { process_name, sequence, responsible_person, description }, req.io);
    console.log('Process created:', process);
    res.status(201).json(process);
  } catch (error) {
    logger.error(`Error creating process for component ${componentId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/components/:componentId/materials', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  const { componentId } = req.params;
  try {
    console.log(`Fetching materials for component ${componentId}`);
    const { rows } = await pool.query(
      `SELECT material_id, component_id, raw_material_id, quantity_per_unit, required_quantity
       FROM component_raw_materials
       WHERE component_id = $1`,
      [componentId]
    );
    const materials = rows.map(row => ({
      materialId: row.material_id,
      componentId: row.component_id,
      rawMaterialId: row.raw_material_id,
      quantityPerUnit: row.quantity_per_unit,
      requiredQuantity: row.required_quantity
    }));
    console.log('Materials fetched:', materials);
    res.json(materials);
  } catch (error) {
    logger.error(`Error fetching materials for component ${componentId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/components/:componentId/materials/:materialId', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { componentId, materialId } = req.params;
  const { quantity_per_unit, required_quantity } = req.body;
  try {
    if ((quantity_per_unit != null && (!Number.isInteger(Number(quantity_per_unit)) || Number(quantity_per_unit) < 0)) ||
        (required_quantity != null && (!Number.isInteger(Number(required_quantity)) || Number(required_quantity) < 0))) {
      return res.status(400).json({ error: 'Invalid input: quantity_per_unit and required_quantity must be non-negative integers' });
    }
    if (quantity_per_unit == null && required_quantity == null) {
      return res.status(400).json({ error: 'Invalid input: at least one of quantity_per_unit or required_quantity must be provided' });
    }
    console.log(`Updating material ${materialId} for component ${componentId}:`, { quantity_per_unit, required_quantity });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [component] } = await client.query('SELECT component_id FROM components WHERE component_id = $1', [componentId]);
      if (!component) throw new Error(`Component ${componentId} not found`);

      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (quantity_per_unit != null) {
        updates.push(`quantity_per_unit = $${paramIndex++}`);
        values.push(quantity_per_unit);
      }
      if (required_quantity != null) {
        updates.push(`required_quantity = $${paramIndex++}`);
        values.push(required_quantity);
      }

      values.push(materialId, componentId);

      const { rows: [material] } = await client.query(
        `UPDATE component_raw_materials
         SET ${updates.join(', ')}
         WHERE material_id = $${paramIndex} AND component_id = $${paramIndex + 1}
         RETURNING material_id, component_id, raw_material_id, quantity_per_unit, required_quantity`,
        values
      );

      if (!material) throw new Error(`Material ${materialId} not found for component ${componentId}`);

      if (req.io) {
        req.io.emit('componentRawMaterialUpdate', {
          materialId: material.material_id,
          componentId: material.component_id,
          rawMaterialId: material.raw_material_id,
          quantityPerUnit: material.quantity_per_unit,
          requiredQuantity: material.required_quantity
        });
      }

      // Invalidate cache for related processes
      setImmediate(async () => {
        try {
          const { rows: [workOrder] } = await client.query(
            'SELECT order_id FROM work_orders WHERE component_id = $1 LIMIT 1',
            [componentId]
          );
          if (workOrder) {
            const keys = await redis.keys(`processes_${workOrder.order_id}_*`);
            if (keys.length) await redis.del(keys);
            logger.info(`Cleared caches for processes after updating material for component ${componentId}`);
          }
        } catch (err) {
          logger.error('Cache invalidation error', err);
        }
      });

      await client.query('COMMIT');
      const response = {
        materialId: material.material_id,
        componentId: material.component_id,
        rawMaterialId: material.raw_material_id,
        quantityPerUnit: material.quantity_per_unit,
        requiredQuantity: material.required_quantity
      };
      console.log('Material updated:', response);
      res.json(response);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.message.includes('Insufficient quantity_per_unit')) {
        res.status(400).json({ error: error.message });
      } else {
        throw error;
      }
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(`Error updating material ${materialId} for component ${componentId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.post('/components/:componentId/materials', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { componentId } = req.params;
  const { raw_material_id, quantity_per_unit, required_quantity } = req.body;
  try {
    if (!raw_material_id || quantity_per_unit == null || required_quantity == null) {
      return res.status(400).json({ error: 'Invalid input: raw_material_id, quantity_per_unit, and required_quantity required' });
    }
    if (!Number.isInteger(Number(quantity_per_unit)) || Number(quantity_per_unit) < 0 ||
        !Number.isInteger(Number(required_quantity)) || Number(required_quantity) < 0) {
      return res.status(400).json({ error: 'Invalid input: quantity_per_unit and required_quantity must be non-negative integers' });
    }
    if (quantity_per_unit < required_quantity) {
      return res.status(400).json({ error: 'Invalid input: quantity_per_unit must be at least required_quantity' });
    }
    console.log(`Assigning raw material to component ${componentId}:`, { raw_material_id, quantity_per_unit, required_quantity });
    const material = await Process.createComponentRawMaterial(componentId, { raw_material_id, quantity_per_unit, required_quantity }, req.io);
    console.log('Material assigned:', material);
    res.status(201).json(material);
  } catch (error) {
    logger.error(`Error assigning raw material to component ${componentId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/:orderId/stages', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  const { orderId } = req.params;
  const { force_refresh } = req.query;
  const cacheKey = `stages_${orderId}_${req.user?.userId || 'anon'}`;

  try {
    console.log(`Fetching stages for order ${orderId}`);
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      console.log(`Cache cleared for key: ${cacheKey}`);
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for key: ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const { rows } = await pool.query(
      `SELECT stage_name, TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date
       FROM order_stages
       WHERE order_id = $1
       ORDER BY stage_date`,
      [orderId]
    );

    const response = rows.map(row => ({
      stageName: row.stage_name,
      stageDate: row.stage_date
    }));

    console.log('Stages fetched:', response);
    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching stages for order ${orderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/:orderId', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  const { orderId } = req.params;
  const { instance_group_id, limit, cursor, force_refresh, responsible_person, overdue } = req.query;
  const userId = req.user?.userId || 'anon';
  const cacheKey = `processes_${orderId}_${instance_group_id || 'all'}_${limit || 10}_${cursor || 'none'}_${userId}`;

  try {
    console.log('Pool in GET /:orderId route:', pool ? 'Defined' : 'Undefined');
    console.log(`Fetching processes for order ${orderId} with params:`, { instance_group_id, limit, cursor, responsible_person, overdue });
    if (force_refresh === 'true') {
      await redis.del(cacheKey);
      console.log(`Cache cleared for key: ${cacheKey}`);
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for key: ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const processes = await Process.getAll({ order_id: orderId, instance_group_id, limit: parseInt(limit, 10), cursor, responsible_person, overdue: overdue === 'true' });
    console.log('Processes fetched:', processes);
    const response = {
      workOrders: processes.data.map(formatResponse),
      total: processes.total,
      nextCursor: processes.nextCursor
    };
    console.log('Response to frontend:', response);

    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching processes for order ${orderId}: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

router.post('/:orderId', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { orderId } = req.params;
  const { component_id, instance_group_id, quantity, target_date } = req.body;
  try {
    if (!component_id || !quantity) {
      return res.status(400).json({ error: 'Invalid input: component_id and quantity required' });
    }
    console.log('Pool in POST /:orderId route:', pool ? 'Defined' : 'Undefined');
    console.log(`Creating work order for order ${orderId}:`, { component_id, instance_group_id, quantity, target_date });
    const workOrder = await Process.create(orderId, { component_id, instance_group_id, quantity, target_date }, req.io);
    const { rows: [component] } = await pool.query('SELECT component_name, product_type FROM components WHERE component_id = $1', [workOrder.componentId]);
    const { rows: [instanceGroup] } = instance_group_id ? await pool.query('SELECT instance_name, instance_type FROM instance_groups WHERE instance_group_id = $1', [workOrder.instanceGroupId]) : { rows: [{}] };

    const response = formatResponse({
      ...workOrder,
      componentName: component.component_name,
      productType: component.product_type,
      instanceName: instanceGroup.instance_name || null,
      instanceType: instanceGroup.instance_type || null,
      processes: [],
      materials: [],
      orderStages: []
    });
    console.log('Work order created:', response);

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${orderId}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after creating work order for order ${orderId}`);
        console.log(`Cache cleared for order ${orderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error creating work order for order ${orderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/:workOrderId/process-status', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { workOrderId } = req.params;
  const { process_id, status, completed_quantity, raw_quantity_used, completion_date, responsible_person } = req.body;
  try {
    if (!process_id || !status) {
      return res.status(400).json({ error: 'Invalid input: process_id and status required' });
    }
    if (!['Pending', 'In Progress', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status: must be Pending, In Progress, or Completed' });
    }
    if (completed_quantity != null && (!Number.isInteger(Number(completed_quantity)) || Number(completed_quantity) < 0)) {
      return res.status(400).json({ error: 'Invalid completed_quantity: must be a non-negative integer' });
    }
    if (raw_quantity_used != null && (!Number.isInteger(Number(raw_quantity_used)) || Number(raw_quantity_used) < 0)) {
      return res.status(400).json({ error: 'Invalid raw_quantity_used: must be a non-negative integer' });
    }
    if (completed_quantity != null && raw_quantity_used != null && Number(completed_quantity) > Number(raw_quantity_used)) {
      return res.status(400).json({ error: 'Completed quantity cannot exceed raw quantity used' });
    }
    if (completion_date && !/^\d{4}-\d{2}-\d{2}$/.test(completion_date)) {
      return res.status(400).json({ error: 'Invalid completion_date: must be in YYYY-MM-DD format' });
    }
    if (responsible_person != null && (typeof responsible_person !== 'string' || responsible_person.length > 255)) {
      return res.status(400).json({ error: 'Invalid responsible_person: must be a string with max length 255' });
    }
    console.log('Pool in PUT /:workOrderId/process-status route:', pool ? 'Defined' : 'Undefined');
    console.log(`Updating process status for work order ${workOrderId}:`, { process_id, status, completed_quantity, raw_quantity_used, completion_date, responsible_person });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate work order and component
      const { rows: [workOrder] } = await client.query(
        'SELECT work_order_id, component_id, quantity FROM work_orders WHERE work_order_id = $1',
        [workOrderId]
      );
      if (!workOrder) {
        throw new Error(`Work order ${workOrderId} not found`);
      }

      // Validate process_id belongs to the component
      const { rows: [process] } = await client.query(
        'SELECT process_id FROM component_processes WHERE process_id = $1 AND component_id = $2',
        [process_id, workOrder.component_id]
      );
      if (!process) {
        throw new Error(`Process ${process_id} not found for component ${workOrder.component_id}`);
      }

      // Calculate total completed quantity, excluding the current process
      const totalCompletedQty = await getTotalCompletedQuantity(workOrderId, process_id);
      const newTotalCompletedQty = totalCompletedQty + (completed_quantity || 0);

      // Validate total completed quantity
      if (newTotalCompletedQty > workOrder.quantity) {
        throw new Error(`Total completed quantity (${newTotalCompletedQty}) exceeds work order quantity (${workOrder.quantity})`);
      }

      // Update process_status
      const updates = ['status = $1'];
      const values = [status];
      let paramIndex = 2;

      if (completed_quantity != null) {
        updates.push(`completed_quantity = $${paramIndex++}`);
        values.push(completed_quantity);
      }
      if (raw_quantity_used != null) {
        updates.push(`raw_quantity_used = $${paramIndex++}`);
        values.push(raw_quantity_used);
      }
      if (completion_date) {
        updates.push(`completion_date = $${paramIndex++}`);
        values.push(completion_date);
      } else {
        updates.push(`completion_date = NULL`);
      }
      if (responsible_person != null) {
        updates.push(`responsible_person = $${paramIndex++}`);
        values.push(responsible_person);
      }

      values.push(workOrderId, process_id);

      const { rows: [statusRecord] } = await client.query(
        `UPDATE process_status
         SET ${updates.join(', ')}
         WHERE work_order_id = $${paramIndex} AND process_id = $${paramIndex + 1}
         RETURNING status_id, work_order_id, process_id, status, completed_quantity, raw_quantity_used, 
                  TO_CHAR(completion_date, 'YYYY-MM-DD') AS completion_date, responsible_person`,
        values
      );

      if (!statusRecord) {
        throw new Error(`Process status not found for work order ${workOrderId} and process ${process_id}`);
      }

      // Update work order status based on process statuses
      const { rows: processStatuses } = await client.query(
        'SELECT status FROM process_status WHERE work_order_id = $1',
        [workOrderId]
      );
      const allCompleted = processStatuses.every(ps => ps.status === 'Completed');
      const anyInProgress = processStatuses.some(ps => ps.status === 'In Progress');
      const newWorkOrderStatus = allCompleted ? 'Completed' : anyInProgress ? 'In Progress' : 'Pending';

      await client.query(
        'UPDATE work_orders SET status = $1 WHERE work_order_id = $2',
        [newWorkOrderStatus, workOrderId]
      );

      // Fetch updated work order details
      const { rows: [updatedWorkOrder] } = await client.query(
        `SELECT wo.work_order_id, wo.order_id, wo.component_id, c.component_name, c.product_type, 
                wo.instance_group_id, ig.instance_name, ig.instance_type, wo.quantity, wo.target_date, wo.status, 
                TO_CHAR(wo.created_at, 'YYYY-MM-DD') AS created_at
         FROM work_orders wo
         JOIN components c ON wo.component_id = c.component_id
         LEFT JOIN instance_groups ig ON wo.instance_group_id = ig.instance_group_id
         WHERE wo.work_order_id = $1`,
        [workOrderId]
      );

      const { rows: processes } = await client.query(
        `SELECT cp.process_id, cp.process_name, cp.sequence, COALESCE(ps.responsible_person, cp.responsible_person) AS responsible_person, cp.description, 
                ps.status, ps.completed_quantity, ps.raw_quantity_used, 
                TO_CHAR(ps.completion_date, 'YYYY-MM-DD') AS completion_date
         FROM component_processes cp
         LEFT JOIN process_status ps ON cp.process_id = ps.process_id AND ps.work_order_id = $1
         WHERE cp.component_id = $2
         ORDER BY cp.sequence`,
        [workOrderId, updatedWorkOrder.component_id]
      );

      const { rows: materials } = await client.query(
        `SELECT wom.work_order_material_id, wom.material_id, crm.raw_material_id, wom.quantity
         FROM work_order_materials wom
         JOIN component_raw_materials crm ON wom.material_id = crm.material_id
         WHERE wom.work_order_id = $1`,
        [workOrderId]
      );

      const { rows: orderStages } = await client.query(
        `SELECT stage_name, TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date
         FROM order_stages
         WHERE order_id = $1`,
        [updatedWorkOrder.order_id]
      );

      if (req.io) {
        req.io.emit('processUpdate', {
          statusId: statusRecord.status_id,
          workOrderId: statusRecord.work_order_id,
          processId: statusRecord.process_id,
          status: statusRecord.status,
          completedQuantity: statusRecord.completed_quantity,
          rawQuantityUsed: statusRecord.raw_quantity_used,
          completionDate: statusRecord.completion_date,
          responsiblePerson: statusRecord.responsible_person
        });
      }

      // Invalidate cache
      setImmediate(async () => {
        try {
          const keys = await redis.keys(`processes_${updatedWorkOrder.order_id}_*`);
          if (keys.length) await redis.del(keys);
          logger.info(`Cleared caches for processes after updating process status for work order ${workOrderId}`);
          console.log(`Cache cleared for work order ${workOrderId}`);
        } catch (err) {
          logger.error('Cache invalidation error', err);
        }
      });

      await client.query('COMMIT');

      const response = formatResponse({
        workOrderId: updatedWorkOrder.work_order_id,
        orderId: new String(updatedWorkOrder.order_id),
        componentId: updatedWorkOrder.component_id,
        componentName: updatedWorkOrder.component_name,
        productType: updatedWorkOrder.product_type,
        instanceGroupId: updatedWorkOrder.instance_group_id,
        instanceName: updatedWorkOrder.instance_name,
        instanceType: updatedWorkOrder.instance_type,
        quantity: updatedWorkOrder.quantity,
        targetDate: updatedWorkOrder.target_date ? updatedWorkOrder.target_date.toISOString().split('T')[0] : null,
        status: updatedWorkOrder.status,
        createdAt: updatedWorkOrder.created_at,
        processes: processes.map(p => ({
          processId: p.process_id,
          processName: p.process_name,
          sequence: p.sequence,
          responsiblePerson: p.responsible_person,
          description: p.description,
          status: p.status,
          completedQuantity: p.completed_quantity,
          rawQuantityUsed: p.raw_quantity_used,
          completionDate: p.completion_date
        })),
        materials: materials.map(m => ({
          workOrderMaterialId: m.work_order_material_id,
          materialId: m.material_id,
          rawMaterialId: m.raw_material_id,
          quantity: m.quantity
        })),
        orderStages: orderStages.map(s => ({
          stageName: s.stage_name,
          stageDate: s.stage_date
        }))
      });

      console.log('Process status updated:', response);
      res.json(response);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating process status for work order ${workOrderId}: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(`Error updating process status for work order ${workOrderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/:orderId/stages', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { orderId } = req.params;
  const { stage_name, stage_date } = req.body;
  try {
    if (!stage_name || !stage_date) {
      return res.status(400).json({ error: 'Invalid input: stage_name and stage_date required' });
    }
    if (!['Assembly', 'Testing', 'PDI', 'Packing', 'Dispatch'].includes(stage_name)) {
      return res.status(400).json({ error: 'Invalid stage_name: must be Assembly, Testing, PDI, Packing, or Dispatch' });
    }
    console.log(`Updating order stage for order ${orderId}:`, { stage_name, stage_date });
    const stage = await Process.updateOrderStage(orderId, { stage_name, stage_date }, req.io);
    console.log('Order stage updated:', stage);

    setImmediate(async () => {
      try {
        const stageKeys = await redis.keys(`stages_${orderId}_*`);
        const processKeys = await redis.keys(`processes_${orderId}_*`);
        const keys = [...stageKeys, ...processKeys];
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for stages and processes after updating stage for order ${orderId}`);
        console.log(`Cache cleared for order ${orderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.json({
      stageId: stage.stageId,
      orderId: stage.orderId,
      stageName: stage.stageName,
      stageDate: stage.stageDate,
      timezone: 'Asia/Kolkata'
    });
  } catch (error) {
    logger.error(`Error updating order stage for order ${orderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.post('/:workOrderId/materials', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { workOrderId } = req.params;
  const { material_id, quantity } = req.body;
  try {
    if (!material_id || quantity == null) {
      return res.status(400).json({ error: 'Invalid input: material_id and quantity required' });
    }
    console.log(`Creating work order material for work order ${workOrderId}:`, { material_id, quantity });
    const workOrderMaterial = await Process.createWorkOrderMaterial(workOrderId, { material_id, quantity }, req.io);
    console.log('Work order material created:', workOrderMaterial);
    res.status(201).json({
      workOrderMaterialId: workOrderMaterial.workOrderMaterialId,
      workOrderId: workOrderMaterial.workOrderId,
      materialId: workOrderMaterial.materialId,
      quantity: workOrderMaterial.quantity
    });
  } catch (error) {
    logger.error(`Error creating work order material for work order ${workOrderId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

module.exports = router;