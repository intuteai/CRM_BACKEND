// routes/stock.js
const express = require('express');
const Stock = require('../models/stock');
const pool = require('../config/db');
const { authenticateToken, checkPermission } = require('../middleware/auth');
const logger = require('../utils/logger');
const router = express.Router({ mergeParams: true });

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const { uploadBufferToDrive } = require('../utils/googleDrive');

/* ============================================================
   INPUT VALIDATION (now includes returnableQty)
============================================================ */
const validateStockInput = (req, res, next) => {
  const {
    productName, description, productCode, price,
    stockQuantity, qtyRequired, location, imageUrl,
    returnableQty
  } = req.body;

  if (
    !productName || typeof productName !== "string" ||
    (description && typeof description !== "string") ||
    !productCode || typeof productCode !== "string" ||
    price === undefined || typeof price !== "number" || price < 0 ||
    (stockQuantity !== undefined && typeof stockQuantity !== "number") ||
    (qtyRequired !== undefined && typeof qtyRequired !== "number") ||
    (returnableQty !== undefined && typeof returnableQty !== "number") ||
    (location !== undefined && typeof location !== "string") ||
    (imageUrl !== undefined && imageUrl !== null && typeof imageUrl !== "string")
  ) {
    return res.status(400).json({ error: "Invalid input data", code: "INVALID_INPUT" });
  }

  next();
};

const validateAdjustInput = (req, res, next) => {
  const { quantity, reason } = req.body;
  if (quantity === undefined || typeof quantity !== "number") {
    return res.status(400).json({ error: "Invalid adjustment data", code: "INVALID_INPUT" });
  }
  next();
};

/* ============================================================
   GET ALL RAW MATERIALS
============================================================ */
router.get(
  "/",
  authenticateToken,
  checkPermission("Stock", "can_read"),
  async (req, res) => {
    const { limit = 10, offset = 0 } = req.query;

    try {
      const stockData = await Stock.getAll({
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      });

      res.json(stockData);
    } catch (error) {
      logger.error(`Error fetching stock: ${error.message}`);
      res.status(500).json({ error: "Internal Server Error", code: "SERVER_ERROR" });
    }
  }
);

/* ============================================================
   CREATE RAW MATERIAL
============================================================ */
router.post(
  "/",
  authenticateToken,
  checkPermission("Stock", "can_write"),
  validateStockInput,
  async (req, res) => {
    const {
      productName, description, productCode, price,
      stockQuantity, qtyRequired, location, imageUrl,
      returnableQty
    } = req.body;

    try {
      const stockItem = await Stock.create({
        productName, description, productCode, price,
        stockQuantity, qtyRequired, location, imageUrl,
        returnableQty
      });

      req.io?.emit("stockUpdate", {
        product_id: stockItem.productId,
        stock_quantity: stockItem.stockQuantity,
        returnable_qty: stockItem.returnableQty,
      });

      res.status(201).json(stockItem);
    } catch (error) {
      logger.error("Error creating stock:", error.message);
      res.status(500).json({ error: "Internal Server Error", code: "SERVER_ERROR" });
    }
  }
);

/* ============================================================
   UPDATE RAW MATERIAL
============================================================ */
router.put(
  "/:productId",
  authenticateToken,
  checkPermission("Stock", "can_write"),
  validateStockInput,
  async (req, res) => {
    const productId = parseInt(req.params.productId, 10);

    const {
      productName, description, productCode, price,
      stockQuantity, qtyRequired, location, imageUrl,
      returnableQty
    } = req.body;

    try {
      const updated = await Stock.update(productId, {
        productName, description, productCode, price,
        stockQuantity, qtyRequired, location, imageUrl,
        returnableQty
      });

      req.io?.emit("stockUpdate", {
        product_id: productId,
        stock_quantity: updated.stockQuantity,
        returnable_qty: updated.returnableQty,
      });

      res.json(updated);
    } catch (error) {
      if (error.message === "Stock item not found") {
        return res.status(404).json({ error: "Stock item not found" });
      }
      logger.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

/* ============================================================
   ACCEPT RETURN (transfer qty: returnable_qty → stock_quantity)
============================================================ */
router.post(
  "/:productId/accept-return",
  authenticateToken,
  checkPermission("Stock", "can_write"),
  async (req, res) => {
    const productId = parseInt(req.params.productId, 10);
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" });
    }

    try {
      await pool.query("BEGIN");

      const result = await pool.query(
        `
        UPDATE raw_materials
        SET returnable_qty = returnable_qty - $1,
            stock_quantity = stock_quantity + $1
        WHERE product_id = $2
          AND returnable_qty >= $1
        RETURNING 
          product_id,
          stock_quantity,
          returnable_qty
        `,
        [quantity, productId]
      );

      if (result.rows.length === 0) {
        await pool.query("ROLLBACK");
        return res.status(400).json({ error: "Not enough returnable qty" });
      }

      await pool.query("COMMIT");

      req.io?.emit("stockUpdate", {
        product_id: productId,
        stock_quantity: result.rows[0].stock_quantity,
        returnable_qty: result.rows[0].returnable_qty
      });

      res.json({
        success: true,
        message: "Return accepted",
        data: result.rows[0]
      });
    } catch (error) {
      await pool.query("ROLLBACK");
      logger.error("Error accepting return:", error.message);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

/* ============================================================
   DELETE RAW MATERIAL
============================================================ */
router.delete(
  "/:productId",
  authenticateToken,
  checkPermission("Stock", "can_delete"),
  async (req, res) => {
    const productId = parseInt(req.params.productId, 10);

    try {
      await Stock.delete(productId);

      req.io?.emit("stockUpdate", { product_id: productId, deleted: true });

      res.status(204).send();
    } catch (error) {
      if (error.message === "Stock item not found") {
        return res.status(404).json({ error: "Stock item not found" });
      }
      logger.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

/* ============================================================
   ADJUST STOCK (normal adjustments)
============================================================ */
router.post(
  "/:productId/adjust",
  authenticateToken,
  checkPermission("Stock", "can_write"),
  validateAdjustInput,
  async (req, res) => {
    const productId = parseInt(req.params.productId, 10);
    const { quantity, reason } = req.body;

    try {
      const updated = await Stock.adjustStock({
        productId,
        quantity,
        reason,
        userId: req.user.user_id,
      });

      req.io?.emit("stockUpdate", {
        product_id: productId,
        stock_quantity: updated.stockQuantity,
      });

      res.json(updated);
    } catch (error) {
      if (error.message === "Stock item not found") {
        return res.status(404).json({ error: "Stock item not found" });
      }
      logger.error(error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);

module.exports = router;
