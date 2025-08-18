const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const ordersRoutes = require('./routes/orders');
const inventoryRoutes = require('./routes/inventory');
const stockRoutes = require('./routes/stock');
const queriesRoutes = require('./routes/queries');
const reportsRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const customerInvoicesRoutes = require('./routes/customerInvoices');
const partDrawingsRoutes = require('./routes/partDrawings');
const partDrawingsRawRoutes = require('./routes/partDrawingsRaw');
const priceListRoutes = require('./routes/priceList');
const pdiRoutes = require('./routes/pdi');
const purchaseInvoicesRoutes = require('./routes/purchaseInvoices');
const bomRoutes = require('./routes/bom');
const enquiryRoutes = require('./routes/enquiry');
const dispatchTrackingRoutes = require('./routes/dispatchTracking');
const dashboardRoutes = require('./routes/dashboard');
const problemsRoutes = require('./routes/problems');
const attendanceRoutes = require('./routes/attendance');
const processRoutes = require('./routes/process'); // New import for processes routes
const limiter = require('./middleware/rateLimit');
const errorHandler = require('./middleware/error');
const logger = require('./utils/logger');
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

async function initializeServer() {
  try {
    const pool = require('./config/db');
    const dbResult = await pool.query('SELECT NOW()');
    logger.info('Database connection successful:', dbResult.rows[0]);

    const redis = require('./config/redis');
    await redis.set('test', 'Redis works!');
    const redisReply = await redis.get('test');
    logger.info('Redis connection successful:', redisReply);
  } catch (err) {
    logger.error('Failed to initialize server:', err.stack);
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

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the ERP Backend API' });
});

// Routes (all prefixed with /api/)
app.use('/api/auth', authRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/queries', queriesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customer-invoices', customerInvoicesRoutes);
app.use('/api/part-drawings', partDrawingsRoutes);
app.use('/api/part-drawings-raw', partDrawingsRawRoutes);
app.use('/api/price-list', priceListRoutes);
app.use('/api/pdi', pdiRoutes);
app.use('/api/purchase-invoices', purchaseInvoicesRoutes);
app.use('/api/bom', bomRoutes);
app.use('/api/enquiry', enquiryRoutes);
app.use('/api/dispatch-tracking', dispatchTrackingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/problems', problemsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/process', processRoutes); // New route for processes

app.use(errorHandler);

const PORT = process.env.PORT || 8000;
initializeServer().then(() => {
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}).catch((err) => {
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