const Payslip = require('../../models/hr/payslip');
const logger = require('../../utils/logger');

exports.generate = async (req, res) => {
  try {
    const data = req.body;
    if (!data.employee?.name || !data.period) return res.status(400).json({ error: 'Employee name and period required' });
    const safeName = data.employee.name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const safePeriod = data.period.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `PAYSLIP_${safeName}_${safePeriod}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = Payslip.generate(data, req.io);
    stream.pipe(res);
    logger.info(`Payslip generated: ${filename} by ${req.user.user_id}`);
  } catch (error) {
    logger.error('Payslip route error:', error.message);
    if (!res.headersSent) res.status(400).json({ error: error.message });
  }
};
