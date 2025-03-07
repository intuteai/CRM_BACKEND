# ERP Backend Documentation

This document provides an overview of the ERP (Enterprise Resource Planning) backend built with Node.js and Express. It supports customer management, order processing, inventory tracking, query handling, and reporting, with real-time updates and robust security features.

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Prerequisites](#prerequisites)
5. [Setup](#setup)
6. [Environment Variables](#environment-variables)
7. [API Endpoints](#api-endpoints)
8. [Database Schema](#database-schema)
9. [Real-Time Updates](#real-time-updates)
10. [Security](#security)
11. [Logging](#logging)
12. [Testing](#testing)
13. [Troubleshooting](#troubleshooting)
14. [Future Enhancements](#future-enhancements)

---

## Overview
The ERP backend is designed to manage business operations efficiently. It integrates with PostgreSQL (Aiven-hosted) for persistent storage, Redis for caching, and Socket.IO for real-time updates. It's optimized for development in Visual Studio Code (VS Code) and supports a React frontend with Context API and Axios.

- **Purpose**: Backend for customer, order, inventory, and query management.
- **Tech Stack**: Node.js, Express, PostgreSQL, Redis, Socket.IO, JWT, Winston.
- **Deployment**: Local (currently), scalable to cloud platforms.

---

## Architecture
The backend follows a modular, layered architecture:
- **Config**: Database and service connections (`db.js`, `redis.js`, `socket.js`).
- **Middleware**: Authentication, validation, error handling (`auth.js`, `validate.js`, `error.js`).
- **Models**: Business logic and DB operations (`user.js`, `order.js`, etc.).
- **Routes**: RESTful API endpoints (`auth.js`, `customers.js`, etc.).
- **Utils**: Helpers (`logger.js`, `email.js`).
- **Server**: Entry point (`server.js`).

### File Structure
```
erp-backend/
├── config/
│   ├── db.js
│   ├── redis.js
│   └── socket.js
├── middleware/
│   ├── auth.js
│   ├── error.js
│   ├── rateLimit.js
│   └── validate.js
├── models/
│   ├── user.js
│   ├── order.js
│   ├── inventory.js
│   ├── query.js
│   └── activity.js
├── routes/
│   ├── auth.js
│   ├── customers.js
│   ├── orders.js
│   ├── inventory.js
│   ├── queries.js
│   └── reports.js
├── utils/
│   ├── logger.js
│   └── email.js
├── tests/
│   └── auth.test.js
├── .env
├── server.js
└── package.json
```

## Features
- **Authentication**: JWT-based with role-based access control (RBAC).
- **Customer Management**: CRUD for users with `role_id = 2`.
- **Order Management**: Transactional order creation with inventory updates.
- **Inventory Management**: Stock tracking with real-time updates via Socket.IO.
- **Query Management**: Customer query raising and response tracking.
- **Reporting**: Order summaries and inventory status.
- **Performance**: Redis caching, pagination (`limit`, `offset`).
- **Security**: Helmet headers, rate limiting, input validation.
- **Real-Time**: Socket.IO for stock and query updates.
- **Logging**: Winston logs actions and errors.

---

## Prerequisites
- **Node.js**: v20.17.0 or higher.
- **PostgreSQL**: Aiven-hosted instance (or local).
- **Redis**: Local server (e.g., `C:\Redis\redis-server.exe`).
- **VS Code**: Recommended with extensions:
  - ESLint, Prettier, REST Client, PostgreSQL.

---

## Setup
1. **Clone or Create Project**:
   - Directory: `C:\Users\HP\OneDrive\Desktop\Erp-backend`.
   - Initialize: `npm init -y`.

2. **Install Dependencies**:
   ```bash
   npm install express pg jsonwebtoken bcryptjs dotenv cors redis socket.io winston nodemailer express-validator helmet express-rate-limit
   npm install --save-dev nodemon jest supertest eslint prettier
   ```

3. **Configure Environment**:
   - Create `.env`:
   ```
   PORT=5000
   DB_HOST=erp-db-rahulsrivastava503-2bda.h.aivencloud.com
   DB_PORT=23132
   DB_USER=avnadmin
   DB_PASSWORD=AVNS_U6TztJofgiQujs9et13
   DB_NAME=defaultdb
   JWT_SECRET=your_strong_secret_key_32_chars_minimum
   REDIS_HOST=localhost
   REDIS_PORT=6379
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASS=your_app_specific_password
   ```

4. **Start Redis**:
   - Run in a separate terminal:
   ```powershell
   cd C:\Redis
   .\redis-server.exe
   ```

5. **Run Server**:
   - In VS Code terminal:
   ```bash
   npm run dev
   ```
   - Output:
   ```
   Server running on port 5000
   Connected to Redis
   Connected to PostgreSQL
   ```

## Environment Variables
| Variable | Description | Example Value |
|----------|-------------|---------------|
| PORT | Server port | 5000 |
| DB_HOST | PostgreSQL host | erp-db-rahulsrivastava503-2bda.h.aivencloud.com |
| DB_PORT | PostgreSQL port | 23132 |
| DB_USER | PostgreSQL user | avnadmin |
| DB_PASSWORD | PostgreSQL password | AVNS_U6TztJofgiQujs9et13 |
| DB_NAME | Database name | defaultdb |
| JWT_SECRET | JWT secret key | your_strong_secret_key_32_chars_minimum |
| REDIS_HOST | Redis host | localhost |
| REDIS_PORT | Redis port | 6379 |
| EMAIL_USER | Email sender address | your_email@gmail.com |
| EMAIL_PASS | Email app-specific password | your_app_specific_password |

## API Endpoints

### Authentication
- **POST /auth/signup**
  - Description: Register a new user.
  - Body: `{"name":"string","email":"string","password":"string","role_id":number}`
  - Response: 201 `{ "token": "jwt" }`

- **POST /auth/login**
  - Description: Log in a user.
  - Body: `{"email":"string","password":"string"}`
  - Response: 200 `{ "token": "jwt" }`

### Customers
- **GET /customers**
  - Description: List customers (role_id = 2).
  - Headers: `Authorization: Bearer <token>`
  - Query Params: `limit`, `offset`
  - Response: 200 `{ "data": [{ "user_id": number, "name": string, "email": string }], "total": number }`

- **PUT /customers/:id**
  - Description: Update customer details.
  - Headers: `Authorization: Bearer <token>`
  - Body: `{"name":"string","email":"string"}`
  - Response: 200 `{ updated_user }`

### Orders
- **GET /orders**
  - Description: List orders (filter by user_id optional).
  - Headers: `Authorization: Bearer <token>`
  - Query Params: `limit`, `offset`, `user_id`
  - Response: 200 `{ "data": [order_objects], "total": number }`

- **POST /orders**
  - Description: Create an order with items.
  - Headers: `Authorization: Bearer <token>`
  - Body: `{"target_delivery_date":"YYYY-MM-DD","items":[{"product_id":number,"quantity":number}]}`
  - Response: 201 `{ order_object }`

### Inventory
- **GET /inventory**
  - Description: List inventory items.
  - Headers: `Authorization: Bearer <token>`
  - Query Params: `limit`, `offset`
  - Response: 200 `{ "data": [product_objects], "total": number }`

- **POST /inventory**
  - Description: Add a product.
  - Headers: `Authorization: Bearer <token>`
  - Body: `{"product_name":"string","stock_quantity":number,"price":number}`
  - Response: 201 `{ product_object }`

### Queries
- **GET /queries**
  - Description: List queries.
  - Headers: `Authorization: Bearer <token>`
  - Query Params: `limit`, `offset`
  - Response: 200 `{ "data": [query_objects], "total": number }`

- **POST /queries**
  - Description: Raise a query.
  - Headers: `Authorization: Bearer <token>`
  - Body: `{"query_text":"string"}`
  - Response: 201 `{ query_object }`

- **PUT /queries/:id/respond**
  - Description: Respond to a query.
  - Headers: `Authorization: Bearer <token>`
  - Body: `{"response":"string"}`
  - Response: 200 `{ updated_query }`

### Reports
- **GET /reports/order-summary**
  - Description: Aggregated order report.
  - Headers: `Authorization: Bearer <token>`
  - Query Params: `limit`, `offset`
  - Response: 200 `{ "data": [summary_objects], "total": number }`

- **GET /reports/inventory-status**
  - Description: Low-stock inventory report.
  - Headers: `Authorization: Bearer <token>`
  - Response: 200 `{ "data": [low_stock_items], "total": number }`

## Database Schema
- **roles**: role_id (PK), role_name
- **users**: user_id (PK), name, email (UNIQUE), password_hash, role_id (FK roles), created_at
- **permissions**: permission_id (PK), role_id (FK roles), module, can_read, can_write, can_delete
- **inventory**: product_id (PK), product_name, stock_quantity, price, created_at
- **orders**: order_id (PK), user_id (FK users), status, target_delivery_date, payment_status, created_at
- **order_items**: order_item_id (PK), order_id (FK orders), product_id (FK inventory), quantity, price
- **queries**: query_id (PK), user_id (FK users), query_text, date_of_query_raised, query_status, last_updated
- **query_responses**: response_id (PK), query_id (FK queries), responded_by (FK users), response, response_date
- **activity_logs**: log_id (PK), user_id (FK users), action, details, timestamp

## Real-Time Updates
- **Socket.IO**: Broadcasts events:
  - `stockUpdate`: When inventory changes (POST /orders, POST /inventory).
  - `newQuery`: When a query is raised (POST /queries).
- **Usage**: Frontend can listen via socket.io-client.

## Security
- **JWT**: Tokens with 1-hour expiry, verified on protected routes.
- **RBAC**: Permissions checked via permissions table.
- **Helmet**: Secure HTTP headers.
- **Rate Limiting**: 100 requests per IP per 15 minutes.
- **Validation**: Input validation with express-validator.

## Logging
- **Winston**: Logs to error.log (errors) and combined.log (all events).
- Examples:
  ```
  {"level":"info","message":"User signed up: test@example.com","timestamp":"2025-02-26T..."}
  {"level":"error","message":"Invalid token - POST /orders","timestamp":"2025-02-26T..."}
  ```

## Testing
- **Unit Tests**: tests/auth.test.js (expandable).
- **Run**: `npm test`.
- **Manual Testing**: Use VS Code REST Client with test.rest.

## Troubleshooting
- **Token Expired**: Re-run POST /auth/login.
- **Permission Denied**: Add to permissions table.
- **Stock Insufficient**: Add inventory via POST /inventory.
- **Connection Errors**: Verify .env, Redis (C:\Redis), and PostgreSQL (Aiven).

## Future Enhancements
- **Deployment**: Host on Heroku/AWS.
- **Frontend**: Integrate with React.
- **Tests**: Expand test suite.
- **Features**: Add financials, advanced reporting.