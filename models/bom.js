// const pool = require('../config/db');
// const logger = require('../utils/logger');

// class BOM {
//   // Get all BOM entries with pagination
//   static async getAll({ limit = 10, offset = 0 }) {
//     const query = `
//       SELECT 
//         b.bom_id AS "bomId",
//         b.product_id AS "productId",
//         b.created_at AS "createdAt",
//         b.updated_at AS "updatedAt",
//         ip.product_name AS "productName",
//         COALESCE( 
//           json_agg(
//             json_build_object(
//               'bomMaterialId', bm.bom_material_id,
//               'materialId', bm.material_id,
//               'materialName', rm.product_name,
//               'quantityPerUnit', bm.quantity_per_unit,
//               'unitPrice', bm.unit_price,
//               'totalValue', bm.total_value
//             )
//           ) FILTER (WHERE bm.bom_material_id IS NOT NULL),
//           '[]'
//         ) AS materials
//       FROM bill_of_materials b
//       LEFT JOIN inventory ip ON b.product_id = ip.product_id
//       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
//       LEFT JOIN raw_materials rm ON bm.material_id = rm.product_id
//       GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name
//       ORDER BY b.created_at DESC
//       LIMIT $1 OFFSET $2
//     `;
//     try {
//       const { rows } = await pool.query(query, [limit, offset]);
//       return rows;
//     } catch (error) {
//       logger.error('Error fetching BOMs', { error: error.message, stack: error.stack });
//       throw new Error(`Error fetching BOMs: ${error.message}`);
//     }
//   }

//   // Get a single BOM entry by ID
//   static async getById(bomId) {
//     const query = `
//       SELECT 
//         b.bom_id AS "bomId",
//         b.product_id AS "productId",
//         b.created_at AS "createdAt",
//         b.updated_at AS "updatedAt",
//         ip.product_name AS "productName",
//         COALESCE(
//           json_agg(
//             json_build_object(
//               'bomMaterialId', bm.bom_material_id,
//               'materialId', bm.material_id,
//               'materialName', rm.product_name,
//               'quantityPerUnit', bm.quantity_per_unit,
//               'unitPrice', bm.unit_price,
//               'totalValue', bm.total_value
//             )
//           ) FILTER (WHERE bm.bom_material_id IS NOT NULL),
//           '[]'
//         ) AS materials
//       FROM bill_of_materials b
//       LEFT JOIN inventory ip ON b.product_id = ip.product_id
//       LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
//       LEFT JOIN raw_materials rm ON bm.material_id = rm.product_id
//       WHERE b.bom_id = $1
//       GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name
//     `;
//     try {
//       const { rows } = await pool.query(query, [bomId]);
//       if (rows.length === 0) {
//         throw new Error(`BOM ${bomId} not found`);
//       }
//       return rows[0];
//     } catch (error) {
//       logger.error(`Error fetching BOM ${bomId}`, { error: error.message, stack: error.stack });
//       throw new Error(`Error fetching BOM ${bomId}: ${error.message}`);
//     }
//   }

//   // Create a new BOM with multiple materials
//   static async create({ productId, materials }, io) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Validate productId
//       const productCheck = await client.query(
//         'SELECT product_id, product_name FROM inventory WHERE product_id = $1',
//         [productId]
//       );
//       if (productCheck.rows.length === 0) {
//         throw new Error(`Product ID ${productId} not found in inventory`);
//       }
//       const productName = productCheck.rows[0].product_name;

//       // Validate materials
//       if (!materials || materials.length === 0) {
//         throw new Error('At least one material is required');
//       }
//       const materialDetails = await Promise.all(
//         materials.map(async ({ materialId, quantityPerUnit }) => {
//           if (!materialId || quantityPerUnit <= 0) {
//             throw new Error(`Invalid material data: materialId=${materialId}, quantityPerUnit=${quantityPerUnit}`);
//           }
//           const materialCheck = await client.query(
//             'SELECT product_id, product_name FROM raw_materials WHERE product_id = $1',
//             [materialId]
//           );
//           if (materialCheck.rows.length === 0) {
//             throw new Error(`Material ID ${materialId} not found in raw_materials`);
//           }
//           return {
//             materialId,
//             quantityPerUnit,
//             materialName: materialCheck.rows[0].product_name
//           };
//         })
//       );

//       // Insert BOM header
//       const bomQuery = `
//         INSERT INTO bill_of_materials (product_id, created_at)
//         VALUES ($1, CURRENT_TIMESTAMP)
//         RETURNING 
//           bom_id AS "bomId",
//           product_id AS "productId",
//           created_at AS "createdAt",
//           updated_at AS "updatedAt"
//       `;
//       logger.info('Creating BOM', { productId, materialCount: materials.length });
//       const bomResult = await client.query(bomQuery, [productId]);
//       const bom = bomResult.rows[0];

//       // Insert materials
//       const materialQuery = `
//         INSERT INTO bom_materials (bom_id, material_id, quantity_per_unit)
//         VALUES ($1, $2, $3)
//         RETURNING 
//           bom_material_id AS "bomMaterialId",
//           material_id AS "materialId",
//           quantity_per_unit AS "quantityPerUnit",
//           unit_price AS "unitPrice",
//           total_value AS "totalValue"
//       `;
//       const insertedMaterials = await Promise.all(
//         materials.map(async ({ materialId, quantityPerUnit }) => {
//           const materialResult = await client.query(materialQuery, [
//             bom.bomId,
//             materialId,
//             quantityPerUnit
//           ]);
//           return materialResult.rows[0];
//         })
//       );

//       await client.query('COMMIT');

//       // Construct response
//       const response = {
//         ...bom,
//         productName,
//         materials: insertedMaterials.map((m, i) => ({
//           ...m,
//           materialName: materialDetails[i].materialName
//         }))
//       };

//       logger.info('BOM created successfully', { bomId: bom.bomId, productId });
//       io?.emit('bom:created', response);
//       return response;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       logger.error('Error creating BOM', {
//         error: error.message,
//         stack: error.stack,
//         productId,
//         materials
//       });
//       throw new Error(`Error creating BOM: ${error.message}`);
//     } finally {
//       client.release();
//     }
//   }

//   // Update an existing BOM
//   static async update(bomId, { productId, materials }, io) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Validate productId
//       const productCheck = await client.query(
//         'SELECT product_id, product_name FROM inventory WHERE product_id = $1',
//         [productId]
//       );
//       if (productCheck.rows.length === 0) {
//         throw new Error(`Product ID ${productId} not found in inventory`);
//       }
//       const productName = productCheck.rows[0].product_name;

//       // Validate materials
//       if (!materials || materials.length === 0) {
//         throw new Error('At least one material is required');
//       }
//       const materialDetails = await Promise.all(
//         materials.map(async ({ materialId, quantityPerUnit }) => {
//           if (!materialId || quantityPerUnit <= 0) {
//             throw new Error(`Invalid material data: materialId=${materialId}, quantityPerUnit=${quantityPerUnit}`);
//           }
//           const materialCheck = await client.query(
//             'SELECT product_id, product_name FROM raw_materials WHERE product_id = $1',
//             [materialId]
//           );
//           if (materialCheck.rows.length === 0) {
//             throw new Error(`Material ID ${materialId} not found in raw_materials`);
//           }
//           return {
//             materialId,
//             quantityPerUnit,
//             materialName: materialCheck.rows[0].product_name
//           };
//         })
//       );

//       // Update BOM header
//       const bomQuery = `
//         UPDATE bill_of_materials
//         SET 
//           product_id = $1,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE bom_id = $2
//         RETURNING 
//           bom_id AS "bomId",
//           product_id AS "productId",
//           created_at AS "createdAt",
//           updated_at AS "updatedAt"
//       `;
//       logger.info('Updating BOM', { bomId, productId, materialCount: materials.length });
//       const bomResult = await client.query(bomQuery, [productId, bomId]);
//       if (bomResult.rows.length === 0) {
//         throw new Error(`BOM ${bomId} not found`);
//       }
//       const bom = bomResult.rows[0];

//       // Delete existing materials
//       await client.query('DELETE FROM bom_materials WHERE bom_id = $1', [bomId]);

//       // Insert new materials
//       const materialQuery = `
//         INSERT INTO bom_materials (bom_id, material_id, quantity_per_unit)
//         VALUES ($1, $2, $3)
//         RETURNING 
//           bom_material_id AS "bomMaterialId",
//           material_id AS "materialId",
//           quantity_per_unit AS "quantityPerUnit",
//           unit_price AS "unitPrice",
//           total_value AS "totalValue"
//       `;
//       const insertedMaterials = await Promise.all(
//         materials.map(async ({ materialId, quantityPerUnit }) => {
//           const materialResult = await client.query(materialQuery, [
//             bomId,
//             materialId,
//             quantityPerUnit
//           ]);
//           return materialResult.rows[0];
//         })
//       );

//       await client.query('COMMIT');

//       // Construct response
//       const response = {
//         ...bom,
//         productName,
//         materials: insertedMaterials.map((m, i) => ({
//           ...m,
//           materialName: materialDetails[i].materialName
//         }))
//       };

//       logger.info('BOM updated successfully', { bomId, productId });
//       io?.emit('bom:updated', response);
//       return response;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       logger.error(`Error updating BOM ${bomId}`, {
//         error: error.message,
//         stack: error.stack,
//         productId,
//         materials
//       });
//       throw new Error(`Error updating BOM ${bomId}: ${error.message}`);
//     } finally {
//       client.release();
//     }
//   }

//   // Delete a BOM entry
//   static async delete(bomId, io) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const query = `
//         DELETE FROM bill_of_materials
//         WHERE bom_id = $1
//         RETURNING bom_id AS "bomId"
//       `;
//       logger.info('Deleting BOM', { bomId });
//       const result = await client.query(query, [bomId]);
//       if (result.rows.length === 0) {
//         throw new Error(`BOM ${bomId} not found`);
//       }

//       await client.query('COMMIT');
//       logger.info('BOM deleted successfully', { bomId });
//       io?.emit('bom:deleted', { bomId });
//       return result.rows[0];
//     } catch (error) {
//       await client.query('ROLLBACK');
//       logger.error(`Error deleting BOM ${bomId}`, {
//         error: error.message,
//         stack: error.stack
//       });
//       throw new Error(`Error deleting BOM ${bomId}: ${error.message}`);
//     } finally {
//       client.release();
//     }
//   }
// }

// module.exports = BOM;

const pool = require('../config/db');
const logger = require('../utils/logger');

class BOM {
  // Get all BOM entries with pagination
  static async getAll({ limit = 10, offset = 0 }) {
    const query = `
      SELECT 
        b.bom_id AS "bomId",
        b.product_id AS "productId",
        b.created_at AS "createdAt",
        b.updated_at AS "updatedAt",
        ip.product_name AS "productName",
        ip.product_code AS "productCode", -- Add product_code
        COALESCE( 
          json_agg(
            json_build_object(
              'bomMaterialId', bm.bom_material_id,
              'materialId', bm.material_id,
              'materialName', rm.product_name,
              'quantityPerUnit', bm.quantity_per_unit,
              'unitPrice', bm.unit_price,
              'totalValue', bm.total_value
            )
          ) FILTER (WHERE bm.bom_material_id IS NOT NULL),
          '[]'
        ) AS materials
      FROM bill_of_materials b
      LEFT JOIN inventory ip ON b.product_id = ip.product_id
      LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
      LEFT JOIN raw_materials rm ON bm.material_id = rm.product_id
      GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name, ip.product_code -- Include product_code in GROUP BY
      ORDER BY b.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    try {
      const { rows } = await pool.query(query, [limit, offset]);
      return rows;
    } catch (error) {
      logger.error('Error fetching BOMs', { error: error.message, stack: error.stack });
      throw new Error(`Error fetching BOMs: ${error.message}`);
    }
  }

  // Get a single BOM entry by ID
  static async getById(bomId) {
    const query = `
      SELECT 
        b.bom_id AS "bomId",
        b.product_id AS "productId",
        b.created_at AS "createdAt",
        b.updated_at AS "updatedAt",
        ip.product_name AS "productName",
        ip.product_code AS "productCode", -- Add product_code
        COALESCE(
          json_agg(
            json_build_object(
              'bomMaterialId', bm.bom_material_id,
              'materialId', bm.material_id,
              'materialName', rm.product_name,
              'quantityPerUnit', bm.quantity_per_unit,
              'unitPrice', bm.unit_price,
              'totalValue', bm.total_value
            )
          ) FILTER (WHERE bm.bom_material_id IS NOT NULL),
          '[]'
        ) AS materials
      FROM bill_of_materials b
      LEFT JOIN inventory ip ON b.product_id = ip.product_id
      LEFT JOIN bom_materials bm ON b.bom_id = bm.bom_id
      LEFT JOIN raw_materials rm ON bm.material_id = rm.product_id
      WHERE b.bom_id = $1
      GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name, ip.product_code -- Include product_code in GROUP BY
    `;
    try {
      const { rows } = await pool.query(query, [bomId]);
      if (rows.length === 0) {
        throw new Error(`BOM ${bomId} not found`);
      }
      return rows[0];
    } catch (error) {
      logger.error(`Error fetching BOM ${bomId}`, { error: error.message, stack: error.stack });
      throw new Error(`Error fetching BOM ${bomId}: ${error.message}`);
    }
  }

  // Create a new BOM with multiple materials
  static async create({ productId, materials }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate productId
      const productCheck = await client.query(
        'SELECT product_id, product_name, product_code FROM inventory WHERE product_id = $1', // Include product_code
        [productId]
      );
      if (productCheck.rows.length === 0) {
        throw new Error(`Product ID ${productId} not found in inventory`);
      }
      const { product_name: productName, product_code: productCode } = productCheck.rows[0];

      // Validate materials
      if (!materials || materials.length === 0) {
        throw new Error('At least one material is required');
      }
      const materialDetails = await Promise.all(
        materials.map(async ({ materialId, quantityPerUnit }) => {
          if (!materialId || quantityPerUnit <= 0) {
            throw new Error(`Invalid material data: materialId=${materialId}, quantityPerUnit=${quantityPerUnit}`);
          }
          const materialCheck = await client.query(
            'SELECT product_id, product_name FROM raw_materials WHERE product_id = $1',
            [materialId]
          );
          if (materialCheck.rows.length === 0) {
            throw new Error(`Material ID ${materialId} not found in raw_materials`);
          }
          return {
            materialId,
            quantityPerUnit,
            materialName: materialCheck.rows[0].product_name
          };
        })
      );

      // Insert BOM header
      const bomQuery = `
        INSERT INTO bill_of_materials (product_id, created_at)
        VALUES ($1, CURRENT_TIMESTAMP)
        RETURNING 
          bom_id AS "bomId",
          product_id AS "productId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      logger.info('Creating BOM', { productId, materialCount: materials.length });
      const bomResult = await client.query(bomQuery, [productId]);
      const bom = bomResult.rows[0];

      // Insert materials
      const materialQuery = `
        INSERT INTO bom_materials (bom_id, material_id, quantity_per_unit)
        VALUES ($1, $2, $3)
        RETURNING 
          bom_material_id AS "bomMaterialId",
          material_id AS "materialId",
          quantity_per_unit AS "quantityPerUnit",
          unit_price AS "unitPrice",
          total_value AS "totalValue"
      `;
      const insertedMaterials = await Promise.all(
        materials.map(async ({ materialId, quantityPerUnit }) => {
          const materialResult = await client.query(materialQuery, [
            bom.bomId,
            materialId,
            quantityPerUnit
          ]);
          return materialResult.rows[0];
        })
      );

      await client.query('COMMIT');

      // Construct response
      const response = {
        ...bom,
        productName,
        productCode, // Add product_code to response
        materials: insertedMaterials.map((m, i) => ({
          ...m,
          materialName: materialDetails[i].materialName
        }))
      };

      logger.info('BOM created successfully', { bomId: bom.bomId, productId });
      io?.emit('bom:created', response);
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating BOM', {
        error: error.message,
        stack: error.stack,
        productId,
        materials
      });
      throw new Error(`Error creating BOM: ${error.message}`);
    } finally {
      client.release();
    }
  }

  // Update an existing BOM
  static async update(bomId, { productId, materials }, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Validate productId
      const productCheck = await client.query(
        'SELECT product_id, product_name, product_code FROM inventory WHERE product_id = $1', // Include product_code
        [productId]
      );
      if (productCheck.rows.length === 0) {
        throw new Error(`Product ID ${productId} not found in inventory`);
      }
      const { product_name: productName, product_code: productCode } = productCheck.rows[0];

      // Validate materials
      if (!materials || materials.length === 0) {
        throw new Error('At least one material is required');
      }
      const materialDetails = await Promise.all(
        materials.map(async ({ materialId, quantityPerUnit }) => {
          if (!materialId || quantityPerUnit <= 0) {
            throw new Error(`Invalid material data: materialId=${materialId}, quantityPerUnit=${quantityPerUnit}`);
          }
          const materialCheck = await client.query(
            'SELECT product_id, product_name FROM raw_materials WHERE product_id = $1',
            [materialId]
          );
          if (materialCheck.rows.length === 0) {
            throw new Error(`Material ID ${materialId} not found in raw_materials`);
          }
          return {
            materialId,
            quantityPerUnit,
            materialName: materialCheck.rows[0].product_name
          };
        })
      );

      // Update BOM header
      const bomQuery = `
        UPDATE bill_of_materials
        SET 
          product_id = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE bom_id = $2
        RETURNING 
          bom_id AS "bomId",
          product_id AS "productId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      logger.info('Updating BOM', { bomId, productId, materialCount: materials.length });
      const bomResult = await client.query(bomQuery, [productId, bomId]);
      if (bomResult.rows.length === 0) {
        throw new Error(`BOM ${bomId} not found`);
      }
      const bom = bomResult.rows[0];

      // Delete existing materials
      await client.query('DELETE FROM bom_materials WHERE bom_id = $1', [bomId]);

      // Insert new materials
      const materialQuery = `
        INSERT INTO bom_materials (bom_id, material_id, quantity_per_unit)
        VALUES ($1, $2, $3)
        RETURNING 
          bom_material_id AS "bomMaterialId",
          material_id AS "materialId",
          quantity_per_unit AS "quantityPerUnit",
          unit_price AS "unitPrice",
          total_value AS "totalValue"
      `;
      const insertedMaterials = await Promise.all(
        materials.map(async ({ materialId, quantityPerUnit }) => {
          const materialResult = await client.query(materialQuery, [
            bomId,
            materialId,
            quantityPerUnit
          ]);
          return materialResult.rows[0];
        })
      );

      await client.query('COMMIT');

      // Construct response
      const response = {
        ...bom,
        productName,
        productCode, // Add product_code to response
        materials: insertedMaterials.map((m, i) => ({
          ...m,
          materialName: materialDetails[i].materialName
        }))
      };

      logger.info('BOM updated successfully', { bomId, productId });
      io?.emit('bom:updated', response);
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error updating BOM ${bomId}`, {
        error: error.message,
        stack: error.stack,
        productId,
        materials
      });
      throw new Error(`Error updating BOM ${bomId}: ${error.message}`);
    } finally {
      client.release();
    }
  }

  // Delete a BOM entry
  static async delete(bomId, io) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        DELETE FROM bill_of_materials
        WHERE bom_id = $1
        RETURNING bom_id AS "bomId"
      `;
      logger.info('Deleting BOM', { bomId });
      const result = await client.query(query, [bomId]);
      if (result.rows.length === 0) {
        throw new Error(`BOM ${bomId} not found`);
      }

      await client.query('COMMIT');
      logger.info('BOM deleted successfully', { bomId });
      io?.emit('bom:deleted', { bomId });
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Error deleting BOM ${bomId}`, {
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Error deleting BOM ${bomId}: ${error.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = BOM;