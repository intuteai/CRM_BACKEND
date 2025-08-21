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

router.post('/components/:componentId/materials', authenticateToken, checkPermission('Processes', 'can_write'), async (req, res, next) => {
  const { componentId } = req.params;
  const { raw_material_id, quantity_per_unit } = req.body;
  try {
    if (!raw_material_id || quantity_per_unit == null) {
      return res.status(400).json({ error: 'Invalid input: raw_material_id and quantity_per_unit required' });
    }
    console.log(`Assigning raw material to component ${componentId}:`, { raw_material_id, quantity_per_unit });
    const material = await Process.createComponentRawMaterial(componentId, { raw_material_id, quantity_per_unit }, req.io);
    console.log('Material assigned:', material);
    res.status(201).json(material);
  } catch (error) {
    logger.error(`Error assigning raw material to component ${componentId}: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.get('/:orderId', authenticateToken, checkPermission('Processes', 'can_read'), async (req, res, next) => {
  const { orderId } = req.params;
  const { instance_group_id, limit, cursor, force_refresh, responsible_person, overdue } = req.query;
  const userId = req.user.userId;
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

    await redis.setex(cacheKey, 300, JSON.stringify(response));
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
  const { process_id, status, completed_quantity, completion_date } = req.body;
  try {
    if (!process_id || !status) {
      return res.status(400).json({ error: 'Invalid input: process_id and status required' });
    }
    console.log('Pool in PUT /:workOrderId/process-status route:', pool ? 'Defined' : 'Undefined');
    console.log(`Updating process status for work order ${workOrderId}:`, { process_id, status, completed_quantity, completion_date });
    const processStatus = await Process.updateProcessStatus(workOrderId, { process_id, status, completed_quantity, completion_date }, req.io);
    const { rows: [workOrder] } = await pool.query(
      `SELECT wo.work_order_id, wo.order_id, wo.component_id, c.component_name, c.product_type, 
              wo.instance_group_id, ig.instance_name, ig.instance_type, wo.quantity, wo.target_date, wo.status, 
              TO_CHAR(wo.created_at, 'YYYY-MM-DD') AS created_at
       FROM work_orders wo
       JOIN components c ON wo.component_id = c.component_id
       LEFT JOIN instance_groups ig ON wo.instance_group_id = ig.instance_group_id
       WHERE wo.work_order_id = $1`,
      [workOrderId]
    );

    const { rows: processes } = await pool.query(
      `SELECT cp.process_id, cp.process_name, cp.sequence, cp.responsible_person, cp.description, 
              ps.status, ps.completed_quantity, TO_CHAR(ps.completion_date, 'YYYY-MM-DD') AS completion_date
       FROM component_processes cp
       LEFT JOIN process_status ps ON cp.process_id = ps.process_id AND ps.work_order_id = $1
       WHERE cp.component_id = $2
       ORDER BY cp.sequence`,
      [workOrderId, workOrder.component_id]
    );

    const { rows: materials } = await pool.query(
      `SELECT wom.work_order_material_id, wom.material_id, crm.raw_material_id, wom.quantity
       FROM work_order_materials wom
       JOIN component_raw_materials crm ON wom.material_id = crm.material_id
       WHERE wom.work_order_id = $1`,
      [workOrderId]
    );

    const { rows: orderStages } = await pool.query(
      `SELECT stage_name, TO_CHAR(stage_date, 'YYYY-MM-DD') AS stage_date
       FROM order_stages
       WHERE order_id = $1`,
      [workOrder.order_id]
    );

    const response = formatResponse({
      workOrderId: workOrder.work_order_id,
      orderId: workOrder.order_id,
      componentId: workOrder.component_id,
      componentName: workOrder.component_name,
      productType: workOrder.product_type,
      instanceGroupId: workOrder.instance_group_id,
      instanceName: workOrder.instance_name,
      instanceType: workOrder.instance_type,
      quantity: workOrder.quantity,
      targetDate: workOrder.target_date ? workOrder.target_date.toISOString().split('T')[0] : null,
      status: workOrder.status,
      createdAt: workOrder.created_at,
      processes: processes.map(p => ({
        processId: p.process_id,
        processName: p.process_name,
        sequence: p.sequence,
        responsiblePerson: p.responsible_person,
        description: p.description,
        status: p.status,
        completedQuantity: p.completed_quantity,
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

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${workOrder.order_id}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after updating process status for work order ${workOrderId}`);
        console.log(`Cache cleared for work order ${workOrderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.json(response);
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
    console.log(`Updating order stage for order ${orderId}:`, { stage_name, stage_date });
    const stage = await Process.updateOrderStage(orderId, { stage_name, stage_date }, req.io);
    console.log('Order stage updated:', stage);
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