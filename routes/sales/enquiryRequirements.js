const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticateToken, checkPermission } = require('../../middleware/auth');
const controller = require('../../controllers/sales/enquiryRequirements.controller');

const validateMotorType = (req, res, next) => {
  const { motors } = req.body;
  if (motors !== undefined) {
    if (!Array.isArray(motors)) return res.status(400).json({ error: 'motors must be an array', code: 'INVALID_INPUT' });
    for (const m of motors) {
      if (m.motor_type !== undefined && m.motor_type !== null && !['BLDC', 'PMSM'].includes(m.motor_type)) {
        return res.status(400).json({ error: 'motor_type must be BLDC or PMSM', code: 'INVALID_INPUT' });
      }
    }
  }
  next();
};

router.get('/', authenticateToken, checkPermission('EnquiryRequirements', 'can_read'), controller.getAll);
router.get('/:id', authenticateToken, checkPermission('EnquiryRequirements', 'can_read'), controller.getOne);
router.post('/', authenticateToken, checkPermission('EnquiryRequirements', 'can_write'), validateMotorType, controller.create);
router.put('/:id', authenticateToken, checkPermission('EnquiryRequirements', 'can_write'), validateMotorType, controller.update);
router.delete('/:id', authenticateToken, checkPermission('EnquiryRequirements', 'can_delete'), controller.delete);
router.get('/:requirementId/motors', authenticateToken, checkPermission('EnquiryRequirements', 'can_read'), controller.listMotors);
router.post('/:requirementId/motors', authenticateToken, checkPermission('EnquiryRequirements', 'can_write'), controller.addMotor);
router.put('/motors/:motorId', authenticateToken, checkPermission('EnquiryRequirements', 'can_write'), controller.updateMotor);
router.delete('/motors/:motorId', authenticateToken, checkPermission('EnquiryRequirements', 'can_delete'), controller.deleteMotor);

module.exports = router;
