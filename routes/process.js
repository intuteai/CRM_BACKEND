const express = require('express');
const router = express.Router({ mergeParams: true });
const Process = require('../models/process');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const redis = require('../config/redis');
const pool = require('../config/db');

const formatWorkOrderResponse = (workOrder) => ({
  workOrderId: workOrder.workOrderId,
  orderId: workOrder.orderId,
  instanceGroupId: workOrder.instanceGroupId,
  instanceName: workOrder.instanceName,
  instanceType: workOrder.instanceType,
  targetDate: workOrder.targetDate,
  status: workOrder.status,
  createdAt: workOrder.createdAt,
  stages: workOrder.stages ?? [],
  components: workOrder.components.map((component) => ({
    workOrderComponentId: component.workOrderComponentId,
    componentId: component.componentId,
    componentName: component.componentName,
    productType: component.productType,
    quantity: component.quantity,
    processes: component.processes.map((process) => ({
      processId: process.processId,
      processName: process.processName,
      sequence: process.sequence,
      responsiblePerson: process.responsiblePerson,
      description: process.description,
      status: process.status,
      completedQuantity: process.completedQuantity,
      inUseQuantity: process.inUseQuantity,
      allowedQuantity: process.allowedQuantity,
      completionDate: process.completionDate,
    })),
    materials: component.materials.map((material) => ({
      workOrderMaterialId: material.workOrderMaterialId,
      rawMaterialId: material.rawMaterialId,
      rawMaterialName: material.rawMaterialName,
      quantity: material.quantity,
    })),
  })),
  timezone: 'Asia/Kolkata',
});

// ────────────────────────────────────────────────
//  STATIC ROUTES FIRST
// ────────────────────────────────────────────────

router.get(
  '/orders',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res, next) => {
    try {
      const orders = await Process.getOrders();
      const orderIds = orders.map((order) => order.order_id);
      const { rows: customers } = await pool.query(
        'SELECT DISTINCT o.order_id, u.name FROM orders o JOIN users u ON o.user_id = u.user_id WHERE o.order_id = ANY($1)',
        [orderIds]
      );
      const customerMap = new Map(customers.map((c) => [c.order_id, c.name || 'Unknown']));

      res.json(
        orders.map((order) => ({
          orderId: order.order_id,
          status: order.status,
          targetDeliveryDate: order.target_delivery_date
            ? order.target_delivery_date.toISOString().split('T')[0]
            : null,
          createdAt: order.created_at,
          customerName: customerMap.get(order.order_id),
          timezone: 'Asia/Kolkata',
        }))
      );
    } catch (error) {
      logger.error(`Error fetching orders: ${error.message}`, { stack: error.stack });
      next(error);
    }
  }
);

router.get(
  '/components',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res, next) => {
    try {
      const components = await Process.getComponents();
      res.json(components);
    } catch (error) {
      logger.error(`Components fetch error: ${error.message}`, { stack: error.stack });
      next(error);
    }
  }
);

router.post(
  '/components',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { component_name, product_type } = req.body;
    if (!component_name || !product_type) {
      return res.status(400).json({ error: 'component_name and product_type required' });
    }

    try {
      const component = await Process.createComponent({ component_name, product_type }, req.io);
      res.status(201).json(component);
    } catch (error) {
      logger.error(`Create component failed: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

router.post(
  '/components/:componentId/processes',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { componentId } = req.params;
    const { process_name, sequence, responsible_person, description } = req.body;

    if (!process_name || sequence == null) {
      return res.status(400).json({ error: 'process_name and sequence required' });
    }

    try {
      const process = await Process.createComponentProcess(
        componentId,
        { process_name, sequence, responsible_person, description },
        req.io
      );
      res.status(201).json(process);
    } catch (error) {
      logger.error(`Create process failed - component ${componentId}: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

// ────────────────────────────────────────────────
//  WORK ORDER COMPONENT ROUTES
// ────────────────────────────────────────────────

router.post(
  '/work-orders/:workOrderId/components',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { workOrderId } = req.params;
    const { component_id, quantity } = req.body;

    if (!component_id || !quantity) {
      return res.status(400).json({ error: 'component_id and quantity required' });
    }

    if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }

    try {
      const workOrderComponent = await Process.createWorkOrderComponent(
        workOrderId,
        { component_id, quantity },
        req.io
      );

      const { rows: [comp] } = await pool.query(
        'SELECT component_name, product_type FROM components WHERE component_id = $1',
        [component_id]
      );

      const response = {
        workOrderComponentId: workOrderComponent.workOrderComponentId,
        workOrderId: workOrderComponent.workOrderId,
        componentId: workOrderComponent.componentId,
        componentName: comp.component_name,
        productType: comp.product_type,
        quantity: workOrderComponent.quantity,
        processes: [],
        materials: [],
      };

      setImmediate(async () => {
        try {
          const { rows: [wo] } = await pool.query('SELECT order_id FROM work_orders WHERE work_order_id = $1', [workOrderId]);
          if (wo) {
            const keys = await redis.keys(`processes_${wo.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after component attachment', err);
        }
      });

      res.status(201).json(response);
    } catch (error) {
      logger.error(`Attach component failed - work order ${workOrderId}: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

router.get(
  '/components/:workOrderComponentId/processes',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res) => {
    const { workOrderComponentId } = req.params;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          cp.process_id,
          cp.process_name,
          cp.sequence,
          cp.description,
          ps.status,
          ps.completed_quantity,
          ps.in_use_quantity,
          ps.allowed_quantity,
          ps.completion_date,
          ps.responsible_person
        FROM work_order_components woc
        JOIN component_processes cp
          ON cp.component_id = woc.component_id
        LEFT JOIN process_status ps
          ON ps.process_id = cp.process_id
         AND ps.work_order_component_id = woc.work_order_component_id
        WHERE woc.work_order_component_id = $1
        ORDER BY cp.sequence
        `,
        [workOrderComponentId]
      );

      res.json(
        rows.map(r => ({
          processId: r.process_id,
          processName: r.process_name,
          sequence: r.sequence,
          description: r.description,
          status: r.status || 'Pending',
          completedQuantity: r.completed_quantity ?? 0,
          inUseQuantity: r.in_use_quantity ?? 0,
          allowedQuantity: r.allowed_quantity ?? 0,
          completionDate: r.completion_date,
          responsiblePerson: r.responsible_person,
        }))
      );
    } catch (error) {
      logger.error(
        `Fetch processes failed - component ${workOrderComponentId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).json({ error: 'Failed to fetch processes' });
    }
  }
);

router.put(
  '/components/:workOrderComponentId/process-status',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res) => {
    const { workOrderComponentId } = req.params;
    const { process_id, completed_quantity, in_use_quantity, completion_date, responsible_person } = req.body;

    if (!process_id) {
      return res.status(400).json({ error: 'process_id required' });
    }

    if (completed_quantity != null && (!Number.isInteger(Number(completed_quantity)) || Number(completed_quantity) < 0)) {
      return res.status(400).json({ error: 'completed_quantity must be non-negative integer' });
    }

    if (in_use_quantity != null && (!Number.isInteger(Number(in_use_quantity)) || Number(in_use_quantity) < 0)) {
      return res.status(400).json({ error: 'in_use_quantity must be non-negative integer' });
    }

    if (completion_date && !/^\d{4}-\d{2}-\d{2}$/.test(completion_date)) {
      return res.status(400).json({ error: 'completion_date must be in YYYY-MM-DD format' });
    }

    try {
      const result = await Process.updateProcessStatus(workOrderComponentId, {
        process_id,
        completed_quantity: completed_quantity !== undefined ? Number(completed_quantity) : undefined,
        in_use_quantity: in_use_quantity !== undefined ? Number(in_use_quantity) : undefined,
        completion_date,
        responsible_person,
      });

      setImmediate(async () => {
        try {
          const { rows: [woc] } = await pool.query(
            'SELECT wo.order_id FROM work_order_components woc JOIN work_orders wo ON woc.work_order_id = wo.work_order_id WHERE woc.work_order_component_id = $1',
            [workOrderComponentId]
          );
          if (woc) {
            const keys = await redis.keys(`processes_${woc.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after process status update', err);
        }
      });

      if (req.io) {
        req.io.emit('processUpdate', {
          workOrderComponentId,
          processId: process_id,
        });
      }

      res.json(result);
    } catch (error) {
      logger.error(
        `Process status update failed - component ${workOrderComponentId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

router.get(
  '/components/:workOrderComponentId/materials',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res) => {
    const { workOrderComponentId } = req.params;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          wom.work_order_material_id,
          wom.raw_material_id,
          rm.product_name AS raw_material_name,
          wom.quantity
        FROM work_order_materials wom
        JOIN raw_materials rm
          ON rm.product_id = wom.raw_material_id
        WHERE wom.work_order_component_id = $1
        ORDER BY wom.work_order_material_id
        `,
        [workOrderComponentId]
      );

      res.json(
        rows.map(r => ({
          workOrderMaterialId: r.work_order_material_id,
          rawMaterialId: r.raw_material_id,
          rawMaterialName: r.raw_material_name,
          quantity: r.quantity,
        }))
      );
    } catch (error) {
      logger.error(`Fetch materials failed - component ${workOrderComponentId}: ${error.message}`, { stack: error.stack });
      res.status(500).json({ error: 'Failed to fetch materials' });
    }
  }
);

router.post(
  '/components/:workOrderComponentId/materials',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res) => {
    const { workOrderComponentId } = req.params;
    const { raw_material_id, quantity } = req.body;

    if (!raw_material_id || !quantity) {
      return res.status(400).json({ error: 'raw_material_id and quantity required' });
    }

    if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }

    try {
      const material = await Process.createWorkOrderMaterial(workOrderComponentId, {
        raw_material_id,
        quantity,
      });

      const { rows: [rm] } = await pool.query(
        'SELECT product_name FROM raw_materials WHERE product_id = $1',
        [raw_material_id]
      );

      setImmediate(async () => {
        try {
          const { rows: [woc] } = await pool.query(
            'SELECT wo.order_id FROM work_order_components woc JOIN work_orders wo ON woc.work_order_id = wo.work_order_id WHERE woc.work_order_component_id = $1',
            [workOrderComponentId]
          );
          if (woc) {
            const keys = await redis.keys(`processes_${woc.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after material creation/update', err);
        }
      });

      res.status(201).json({
        workOrderMaterialId: material.workOrderMaterialId,
        workOrderComponentId: material.workOrderComponentId,
        rawMaterialId: material.rawMaterialId,
        rawMaterialName: rm?.product_name || null,
        quantity: material.quantity,
      });
    } catch (error) {
      logger.error(
        `Material creation/update failed - component ${workOrderComponentId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

router.put(
  '/components/:workOrderComponentId/materials/:materialId',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res) => {
    const { workOrderComponentId, materialId } = req.params;
    const { quantity } = req.body;

    if (!quantity || !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }

    try {
      const { rows } = await pool.query(
        `UPDATE work_order_materials
         SET quantity = $1
         WHERE work_order_component_id = $2 
         AND work_order_material_id = $3
         RETURNING work_order_material_id, raw_material_id, quantity`,
        [Number(quantity), workOrderComponentId, materialId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Material not found' });
      }

      // Recalculate total material and update allowed_quantity
      const { rows: [{ total_material }] } = await pool.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total_material
         FROM work_order_materials
         WHERE work_order_component_id = $1`,
        [workOrderComponentId]
      );

      await pool.query(
        `UPDATE process_status 
         SET allowed_quantity = $1 
         WHERE work_order_component_id = $2`,
        [parseInt(total_material, 10), workOrderComponentId]
      );

      setImmediate(async () => {
        try {
          const { rows: [woc] } = await pool.query(
            'SELECT wo.order_id FROM work_order_components woc JOIN work_orders wo ON woc.work_order_id = wo.work_order_id WHERE woc.work_order_component_id = $1',
            [workOrderComponentId]
          );
          if (woc) {
            const keys = await redis.keys(`processes_${woc.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after material update', err);
        }
      });

      res.json(rows[0]);
    } catch (error) {
      logger.error(
        `Material update failed - component ${workOrderComponentId} material ${materialId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).json({ error: 'Failed to update material' });
    }
  }
);

router.delete(
  '/components/:workOrderComponentId/materials/:materialId',
  authenticateToken,
  checkPermission('Processes', 'can_delete'),
  async (req, res) => {
    const { workOrderComponentId, materialId } = req.params;

    try {
      const { rows } = await pool.query(
        `DELETE FROM work_order_materials
         WHERE work_order_component_id = $1 
         AND work_order_material_id = $2
         RETURNING work_order_material_id`,
        [workOrderComponentId, materialId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Material not found' });
      }

      // Recalculate total material and update allowed_quantity
      const { rows: [{ total_material }] } = await pool.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total_material
         FROM work_order_materials
         WHERE work_order_component_id = $1`,
        [workOrderComponentId]
      );

      await pool.query(
        `UPDATE process_status 
         SET allowed_quantity = $1 
         WHERE work_order_component_id = $2`,
        [parseInt(total_material, 10), workOrderComponentId]
      );

      setImmediate(async () => {
        try {
          const { rows: [woc] } = await pool.query(
            'SELECT wo.order_id FROM work_order_components woc JOIN work_orders wo ON woc.work_order_id = wo.work_order_id WHERE woc.work_order_component_id = $1',
            [workOrderComponentId]
          );
          if (woc) {
            const keys = await redis.keys(`processes_${woc.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after material deletion', err);
        }
      });

      if (req.io) {
        req.io.emit('materialDeleted', {
          workOrderComponentId,
          materialId,
        });
      }

      res.status(204).send();
    } catch (error) {
      logger.error(
        `Material deletion failed - component ${workOrderComponentId} material ${materialId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).json({ error: 'Failed to delete material' });
    }
  }
);

// ────────────────────────────────────────────────
//  PARAMETERIZED ROUTES
// ────────────────────────────────────────────────

router.post(
  '/:orderId/work-orders',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { orderId } = req.params;
    const { instance_group_id, target_date } = req.body;

    try {
      const workOrder = await Process.createWorkOrder(orderId, { instance_group_id, target_date }, req.io);

      const { rows: [ig] = [{}] } = instance_group_id
        ? await pool.query(
            'SELECT instance_name, instance_type FROM instance_groups WHERE instance_group_id = $1',
            [instance_group_id]
          )
        : [];

      const response = {
        workOrderId: workOrder.work_order_id,
        orderId: workOrder.order_id,
        instanceGroupId: workOrder.instance_group_id,
        instanceName: ig.instance_name || null,
        instanceType: ig.instance_type || null,
        targetDate: workOrder.target_date,
        status: workOrder.status,
        createdAt: workOrder.created_at,
        components: [],
        timezone: 'Asia/Kolkata',
      };

      setImmediate(async () => {
        try {
          const keys = await redis.keys(`processes_${orderId}_*`);
          if (keys.length) await redis.del(keys);
        } catch (err) {
          logger.error('Cache invalidation failed after work order creation', err);
        }
      });

      res.status(201).json(response);
    } catch (error) {
      logger.error(`Create work order failed - order ${orderId}: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

router.get(
  '/:orderId',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res, next) => {
    const { orderId } = req.params;
    const { instance_group_id, limit, cursor, force_refresh } = req.query;
    const userId = req.user?.userId || 'anon';
    const cacheKey = `processes_${orderId}_${instance_group_id || 'all'}_${limit || 10}_${cursor || 'none'}_${userId}`;

    try {
      if (force_refresh === 'true') {
        await redis.del(cacheKey);
      }

      const cached = await redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      const result = await Process.getAll({
        order_id: orderId,
        instance_group_id,
        limit: parseInt(limit, 10) || 10,
        cursor,
      });

      const response = {
        workOrders: result.data.map(formatWorkOrderResponse),
        total: result.total,
        nextCursor: result.nextCursor,
      };

      await redis.setEx(cacheKey, 300, JSON.stringify(response));
      res.json(response);
    } catch (error) {
      logger.error(`Processes fetch error - order ${orderId}: ${error.message}`, { stack: error.stack });
      next(error);
    }
  }
);

router.get(
  '/:orderId/instance-groups',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res, next) => {
    try {
      const instanceGroups = await Process.getInstanceGroups(req.params.orderId);
      res.json(instanceGroups);
    } catch (error) {
      logger.error(`Instance groups error - order ${req.params.orderId}: ${error.message}`, { stack: error.stack });
      next(error);
    }
  }
);

router.post(
  '/:orderId/instance-groups',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { orderId } = req.params;
    const { instance_name, instance_type } = req.body;

    if (!instance_name || !instance_type) {
      return res.status(400).json({ error: 'instance_name and instance_type required' });
    }

    try {
      const instanceGroup = await Process.createInstanceGroup(orderId, { instance_name, instance_type }, req.io);
      res.status(201).json(instanceGroup);
    } catch (error) {
      logger.error(`Create instance group failed - order ${orderId}: ${error.message}`, { stack: error.stack });
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

// ────────────────────────────────────────────────
//  WORK ORDER STAGE ROUTES (NEW)
// ────────────────────────────────────────────────

router.get(
  '/work-orders/:workOrderId/stages',
  authenticateToken,
  checkPermission('Processes', 'can_read'),
  async (req, res, next) => {
    const { workOrderId } = req.params;

    try {
      const stages = await Process.getWorkOrderStages(workOrderId);
      res.json(stages);
    } catch (error) {
      logger.error(
        `Work order stages fetch failed - workOrder ${workOrderId}: ${error.message}`,
        { stack: error.stack }
      );
      next(error);
    }
  }
);

router.put(
  '/work-orders/:workOrderId/stages',
  authenticateToken,
  checkPermission('Processes', 'can_write'),
  async (req, res, next) => {
    const { workOrderId } = req.params;
    const { stage_name, stage_date } = req.body;

    if (!stage_name) {
      return res.status(400).json({ error: 'stage_name is required' });
    }

    try {
      const result = await Process.updateWorkOrderStage(
        workOrderId,
        { stage_name, stage_date: stage_date || null },
        req.io
      );

      // invalidate order-level process cache
      setImmediate(async () => {
        try {
          const { rows: [wo] } = await pool.query(
            'SELECT order_id FROM work_orders WHERE work_order_id = $1',
            [workOrderId]
          );
          if (wo) {
            const keys = await redis.keys(`processes_${wo.order_id}_*`);
            if (keys.length) await redis.del(keys);
          }
        } catch (err) {
          logger.error('Cache invalidation failed after stage update', err);
        }
      });

      res.json(result);
    } catch (error) {
      logger.error(
        `Work order stage update failed - workOrder ${workOrderId}: ${error.message}`,
        { stack: error.stack }
      );
      res.status(error.status || 400).json({ error: error.message });
    }
  }
);

module.exports = router;