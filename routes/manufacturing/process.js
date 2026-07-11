const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/manufacturing/process.controller');

router.get('/orders', authenticateToken, checkPermission('Processes', 'can_read'), controller.getOrders);
router.get('/components', authenticateToken, checkPermission('Processes', 'can_read'), controller.getComponents);
router.post('/components', authenticateToken, checkPermission('Processes', 'can_write'), controller.createComponent);
router.post('/components/:componentId/processes', authenticateToken, checkPermission('Processes', 'can_write'), controller.createComponentProcess);
router.post('/work-orders/:workOrderId/components', authenticateToken, checkPermission('Processes', 'can_write'), controller.createWorkOrderComponent);
router.get('/components/:workOrderComponentId/processes', authenticateToken, checkPermission('Processes', 'can_read'), controller.getComponentProcesses);
router.put('/components/:workOrderComponentId/process-status', authenticateToken, checkPermission('Processes', 'can_write'), controller.updateProcessStatus);
router.get('/components/:workOrderComponentId/materials', authenticateToken, checkPermission('Processes', 'can_read'), controller.getComponentMaterials);
router.post('/components/:workOrderComponentId/materials', authenticateToken, checkPermission('Processes', 'can_write'), controller.createWorkOrderMaterial);
router.put('/components/:workOrderComponentId/materials/:materialId', authenticateToken, checkPermission('Processes', 'can_write'), controller.updateMaterial);
router.delete('/components/:workOrderComponentId/materials/:materialId', authenticateToken, checkPermission('Processes', 'can_delete'), controller.deleteMaterial);
router.get('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_read'), controller.getWorkOrderStages);
router.put('/work-orders/:workOrderId/stages', authenticateToken, checkPermission('Processes', 'can_write'), controller.updateWorkOrderStage);
router.get('/work-orders/:workOrderId/testing', authenticateToken, checkPermission('Processes', 'can_read'), controller.getTestingResults);
router.put('/work-orders/:workOrderId/testing', authenticateToken, checkPermission('Processes', 'can_write'), controller.upsertTestingResult);
router.post('/:orderId/work-orders', authenticateToken, checkPermission('Processes', 'can_write'), controller.createWorkOrder);
router.get('/:orderId/instance-groups', authenticateToken, checkPermission('Processes', 'can_read'), controller.getInstanceGroups);
router.post('/:orderId/instance-groups', authenticateToken, checkPermission('Processes', 'can_write'), controller.createInstanceGroup);
router.get('/:orderId', authenticateToken, checkPermission('Processes', 'can_read'), controller.getAll);

module.exports = router;
