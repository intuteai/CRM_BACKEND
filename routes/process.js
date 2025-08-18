const express = require('express');
const { Process } = require('../models/process');
const redis = require('../config/redis');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });
const pool = require('../config/db');

router.get('/:orderId', authenticateToken, checkPermission('motor_processes', 'can_read'), async (req, res, next) => {
  const { orderId } = req.params;
  const { limit = 10, cursor, force_refresh = false } = req.query;

  try {
    const parsedLimit = Math.min(parseInt(limit, 10), 100);
    const cacheKey = `processes_${orderId}_${parsedLimit}_${cursor || 'null'}_${req.user.user_id}`;

    if (force_refresh === 'true') await redis.del(cacheKey);

    const cached = await redis.get(cacheKey);
    if (cached && force_refresh !== 'true') {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }

    const { data: workOrders, total, nextCursor } = await Process.getAll({
      order_id: orderId,
      limit: parsedLimit,
      cursor: cursor ? new Date(cursor) : null,
    });

    const processedRows = await Promise.all(workOrders.map(async (wo) => {
      const componentProcesses = wo.processes.map(p => ({
        name: p.name,
        sequence: p.sequence,
        responsible: p.responsible,
        description: p.description,
        status: wo.process_status[p.name]?.status || 'Pending',
        completion_date: wo.process_status[p.name]?.completion_date || null,
      }));
      return {
        id: wo.work_order_id,
        orderId: wo.order_id,
        componentId: wo.component_id,
        componentName: wo.component_name,
        quantity: wo.quantity,
        targetDate: wo.target_date,
        responsiblePerson: wo.responsible_person,
        processes: componentProcesses,
        motorStages: wo.motor_stages,
        status: wo.status,
        createdAt: wo.created_at.toISOString(),
        timezone: 'Asia/Kolkata',
      };
    }));

    const response = {
      workOrders: processedRows,
      total,
      nextCursor: nextCursor ? nextCursor.toISOString() : null,
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(response));
    res.json(response);
  } catch (error) {
    logger.error(`Error fetching work orders for order ${orderId}: ${error.message}`, { stack: error.stack });
    next(error);
  }
});

router.post('/', authenticateToken, checkPermission('motor_processes', 'can_write'), async (req, res, next) => {
  try {
    const { order_id, component_id, quantity, target_date, responsible_person, process_status } = req.body;

    if (!order_id || !component_id || !quantity || !responsible_person) {
      return res.status(400).json({ error: 'Invalid input: order_id, component_id, quantity, and responsible_person required' });
    }

    const workOrder = await Process.create(order_id, component_id, {
      quantity,
      target_date,
      responsible_person,
      process_status,
    }, req.io);

    const { rows: [component] } = await pool.query('SELECT component_name, processes FROM components WHERE component_id = $1', [workOrder.component_id]);

    const componentProcesses = component.processes.map(p => ({
      name: p.name,
      sequence: p.sequence,
      responsible: p.responsible,
      description: p.description,
      status: workOrder.process_status[p.name]?.status || 'Pending',
      completion_date: workOrder.process_status[p.name]?.completion_date || null,
    }));

    const response = {
      id: workOrder.work_order_id,
      orderId: workOrder.order_id,
      componentId: workOrder.component_id,
      componentName: component.component_name,
      quantity: workOrder.quantity,
      targetDate: workOrder.target_date,
      responsiblePerson: workOrder.responsible_person,
      processes: componentProcesses,
      motorStages: workOrder.motor_stages,
      status: workOrder.status,
      createdAt: workOrder.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${order_id}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after creating work order ${workOrder.work_order_id}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error in POST /api/processes: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/:workOrderId/process-status', authenticateToken, checkPermission('motor_processes', 'can_write'), async (req, res, next) => {
  try {
    const { workOrderId } = req.params;
    const { process_name, status, completion_date } = req.body;

    if (!process_name || !status) {
      return res.status(400).json({ error: 'Invalid input: process_name and status required' });
    }

    const workOrder = await Process.updateProcessStatus(workOrderId, {
      process_name,
      status,
      completion_date,
    }, req.io);

    const { rows: [component] } = await pool.query('SELECT component_name, processes FROM components WHERE component_id = $1', [workOrder.component_id]);

    const componentProcesses = component.processes.map(p => ({
      name: p.name,
      sequence: p.sequence,
      responsible: p.responsible,
      description: p.description,
      status: workOrder.process_status[p.name]?.status || 'Pending',
      completion_date: workOrder.process_status[p.name]?.completion_date || null,
    }));

    const response = {
      id: workOrder.work_order_id,
      orderId: workOrder.order_id,
      componentId: workOrder.component_id,
      componentName: component.component_name,
      quantity: workOrder.quantity,
      targetDate: workOrder.target_date,
      responsiblePerson: workOrder.responsible_person,
      processes: componentProcesses,
      motorStages: workOrder.motor_stages,
      status: workOrder.status,
      createdAt: workOrder.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${workOrder.order_id}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after updating work order ${workOrderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.json(response);
  } catch (error) {
    logger.error(`Error in PUT /api/processes/${req.params.workOrderId}/process-status: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.put('/:workOrderId/motor-stages', authenticateToken, checkPermission('motor_processes', 'can_write'), async (req, res, next) => {
  try {
    const { workOrderId } = req.params;
    const { motor_stages } = req.body;

    if (!motor_stages) {
      return res.status(400).json({ error: 'Invalid input: motor_stages required' });
    }

    const workOrder = await Process.updateMotorStages(workOrderId, { motor_stages }, req.io);

    const { rows: [component] } = await pool.query('SELECT component_name, processes FROM components WHERE component_id = $1', [workOrder.component_id]);

    const componentProcesses = component.processes.map(p => ({
      name: p.name,
      sequence: p.sequence,
      responsible: p.responsible,
      description: p.description,
      status: workOrder.process_status[p.name]?.status || 'Pending',
      completion_date: workOrder.process_status[p.name]?.completion_date || null,
    }));

    const response = {
      id: workOrder.work_order_id,
      orderId: workOrder.order_id,
      componentId: workOrder.component_id,
      componentName: component.component_name,
      quantity: workOrder.quantity,
      targetDate: workOrder.target_date,
      responsiblePerson: workOrder.responsible_person,
      processes: componentProcesses,
      motorStages: workOrder.motor_stages,
      status: workOrder.status,
      createdAt: workOrder.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${workOrder.order_id}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after updating motor stages for work order ${workOrderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.json(response);
  } catch (error) {
    logger.error(`Error in PUT /api/processes/${req.params.workOrderId}/motor-stages: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

router.post('/:orderId/pdi', authenticateToken, checkPermission('motor_processes', 'can_write'), async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const { report, description } = req.body;

    if (!report || !description) {
      return res.status(400).json({ error: 'Invalid input: report and description required' });
    }

    const pdiReport = await Process.createPDIReport(orderId, { report, description }, req.io);

    const response = {
      id: pdiReport.report_id,
      orderId: pdiReport.order_id,
      report: pdiReport.report,
      description: pdiReport.description,
      createdAt: pdiReport.created_at.toISOString(),
      timezone: 'Asia/Kolkata',
    };

    setImmediate(async () => {
      try {
        const keys = await redis.keys(`processes_${orderId}_*`);
        if (keys.length) await redis.del(keys);
        logger.info(`Cleared caches for processes after creating PDI report for order ${orderId}`);
      } catch (err) {
        logger.error('Cache invalidation error', err);
      }
    });

    res.status(201).json(response);
  } catch (error) {
    logger.error(`Error in POST /api/processes/${req.params.orderId}/pdi: ${error.message}`, { stack: error.stack });
    res.status(error.status || 400).json({ error: error.message });
  }
});

module.exports = router;