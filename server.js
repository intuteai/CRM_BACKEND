const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const initSocket = require('./config/socket');
const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const ordersRoutes = require('./routes/orders');
const inventoryRoutes = require('./routes/inventory');
const queriesRoutes = require('./routes/queries');
const reportsRoutes = require('./routes/reports');
const userRoutes = require('./routes/users');
const limiter = require('./middleware/rateLimit');
const errorHandler = require('./middleware/error');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = initSocket(server);

(async () => {
  try {
    const pool = require('./config/db');
    const dbResult = await pool.query('SELECT NOW()');
    console.log('DB Test Success:', dbResult.rows[0]);

    const redis = require('./config/redis');
    await redis.set('test', 'Redis works!');
    const redisReply = await redis.get('test');
    console.log('Redis Test Success:', redisReply);
  } catch (err) {
    console.error('Startup Test Error:', err.stack);
    process.exit(1);
  }
})();

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

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the ERP Backend API' });
});

app.use('/api/auth', authRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/queries', queriesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', userRoutes);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${process.env.PORT || 5000}`);
});