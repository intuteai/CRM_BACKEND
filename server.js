const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

// ── Core routes ────────────────────────────────────────────────
const authRoutes             = require('./routes/auth');
const customersRoutes        = require('./routes/core/customers');
const ordersRoutes           = require('./routes/core/orders');
const inventoryRoutes        = require('./routes/core/inventory');
const stockRoutes            = require('./routes/core/stock');
const userRoutes             = require('./routes/core/users');
const reportsRoutes          = require('./routes/core/reports');
const dashboardRoutes        = require('./routes/core/dashboard');

// ── Sales routes ──────────────────────────────────────────────
const enquiryRoutes          = require('./routes/sales/enquiry');
const enquiryReqRoutes       = require('./routes/sales/enquiryRequirements');
const quotationRoutes        = require('./routes/sales/quotation');
const proformaRoutes         = require('./routes/sales/proforma');
const purchaseOrderRoutes    = require('./routes/sales/purchaseOrder');
const priceListRoutes        = require('./routes/sales/priceList');

// ── Manufacturing routes ──────────────────────────────────────
const bomRoutes              = require('./routes/manufacturing/bom');
const partsRoutes            = require('./routes/manufacturing/parts');
const partDrawingsRoutes     = require('./routes/manufacturing/partDrawings');
const partDrawingsRawRoutes  = require('./routes/manufacturing/partDrawingsRaw');
const motorRecipesRoutes     = require('./routes/manufacturing/motorRecipes');
const processRoutes          = require('./routes/manufacturing/process');

// ── Invoicing routes ──────────────────────────────────────────
const customerInvoicesRoutes = require('./routes/invoicing/customerInvoices');
const purchaseInvoicesRoutes = require('./routes/invoicing/purchaseInvoices');

// ── Dispatch routes ───────────────────────────────────────────
const dispatchTrackingRoutes = require('./routes/dispatch/dispatchTracking');
const deliveryChallanRoutes  = require('./routes/dispatch/deliveryChallan');
const iaOrdersRoutes         = require('./routes/dispatch/iaOrders');

// ── HR routes ─────────────────────────────────────────────────
const attendanceRoutes       = require('./routes/hr/attendance');
const employeeDetailsRoutes  = require('./routes/hr/employeeDetails');
const payslipRoutes          = require('./routes/hr/payslip');

// ── Operations routes ─────────────────────────────────────────
const queriesRoutes          = require('./routes/operations/queries');
const activitiesRoutes       = require('./routes/operations/activities');
const problemsRoutes         = require('./routes/operations/problems');
const pdiRoutes              = require('./routes/operations/pdi');

// ── Service & Repair routes ───────────────────────────────────
const serviceRepairRoutes    = require('./routes/service/serviceRepair');

// ── Chatbot routes ────────────────────────────────────────────
const chatbotOrderRoutes          = require('./chatbot/routes/orderChatbotRoutes');
const chatbotCustomerInvoiceRoutes= require('./chatbot/routes/customerInvoiceChatbotRoutes');
const chatbotCustomerRoutes       = require('./chatbot/routes/customerChatbotRoutes');
const chatbotInventoryRoutes      = require('./chatbot/routes/inventoryChatbotRoutes');
const chatbotRawMaterialRoutes    = require('./chatbot/routes/rawMaterialChatbotRoutes');
const chatbotBOMRoutes            = require('./chatbot/routes/bomChatbotRoutes');

// ── Middleware & utilities ────────────────────────────────────
const limiter       = require('./middleware/rateLimit');
const errorHandler  = require('./middleware/error');
const logger        = require('./utils/logger');

require('dotenv').config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
  path: '/socket.io',
});

app.set('socketio', io);
app.set('io', io);

async function initializeServer() {
  try {
    const pool = require('./config/db');
    await pool.query('SELECT 1');

    require('./config/redis');
  } catch (err) {
    logger.error('Server initialization failed:', err.stack);
    process.exit(1);
  }
}

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());
app.use(limiter);

app.use((req, res, next) => {
  req.io = io;
  next();
});

io.on('connection', (socket) => {
  logger.info('Socket.IO client connected:', socket.id);
  socket.on('disconnect', () => logger.info('Socket.IO client disconnected:', socket.id));
});

app.get('/', (req, res) => res.json({ message: 'Welcome to the ERP Backend API' }));

// ==================== ROUTES ====================

// Core
app.use('/api/auth',             authRoutes);
app.use('/api/customers',        customersRoutes);
app.use('/api/orders',           ordersRoutes);
app.use('/api/inventory',        inventoryRoutes);
app.use('/api/stock',            stockRoutes);
app.use('/api/users',            userRoutes);
app.use('/api/reports',          reportsRoutes);
app.use('/api/dashboard',        dashboardRoutes);

// Sales
app.use('/api/enquiry',              enquiryRoutes);
app.use('/api/enquiry-requirements', enquiryReqRoutes);
app.use('/api/quotation',            quotationRoutes);
app.use('/api/proforma',             proformaRoutes);
app.use('/api/purchase-order',       purchaseOrderRoutes);
app.use('/api/price-list',           priceListRoutes);

// Manufacturing
app.use('/api/bom',               bomRoutes);
app.use('/api/parts',             partsRoutes);
app.use('/api/part-drawings',     partDrawingsRoutes);
app.use('/api/part-drawings-raw', partDrawingsRawRoutes);
app.use('/api/motor-recipes',     motorRecipesRoutes);
app.use('/api/process',           processRoutes);

// Invoicing
app.use('/api/customer-invoices',  customerInvoicesRoutes);
app.use('/api/purchase-invoices',  purchaseInvoicesRoutes);

// Dispatch
app.use('/api/dispatch-tracking', dispatchTrackingRoutes);
app.use('/api/delivery-challan',  deliveryChallanRoutes);
app.use('/api/ia-orders',         iaOrdersRoutes);

// HR
app.use('/api/attendance',       attendanceRoutes);
app.use('/api/employee-details', employeeDetailsRoutes);
app.use('/api/payslip',          payslipRoutes);

// Operations
app.use('/api/queries',     queriesRoutes);
app.use('/api/activities',  activitiesRoutes);
app.use('/api/problems',    problemsRoutes);
app.use('/api/pdi',         pdiRoutes);

// Service & Repair
app.use('/api/service-repair', serviceRepairRoutes);

// Chatbot
app.use('/api',             chatbotOrderRoutes);
app.use('/api',             chatbotCustomerInvoiceRoutes);
app.use('/api',             chatbotCustomerRoutes);
app.use('/api',             chatbotInventoryRoutes);
app.use('/api',             chatbotRawMaterialRoutes);
app.use('/api',             chatbotBOMRoutes);

// ==================== CRON JOBS ====================
require('./jobs/daily-due-reminders');
require('./jobs/daily-task-summaries');
require('./jobs/attendanceSummary');

// ==================== GLOBAL ERROR HANDLER ====================
app.use(errorHandler);

// ==================== START SERVER ====================
const PORT = process.env.PORT || 8000;

initializeServer()
  .then(() => {
    server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    logger.error('Server startup failed:', err.stack);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
});

module.exports = app;
