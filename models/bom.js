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
      GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name
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
      GROUP BY b.bom_id, b.product_id, b.created_at, b.updated_at, ip.product_name
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
        'SELECT product_id, product_name FROM inventory WHERE product_id = $1',
        [productId]
      );
      if (productCheck.rows.length === 0) {
        throw new Error(`Product ID ${productId} not found in inventory`);
      }
      const productName = productCheck.rows[0].product_name;

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
        'SELECT product_id, product_name FROM inventory WHERE product_id = $1',
        [productId]
      );
      if (productCheck.rows.length === 0) {
        throw new Error(`Product ID ${productId} not found in inventory`);
      }
      const productName = productCheck.rows[0].product_name;

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

// class BOM {
//   // Get all and getById ... (unchanged) ...

//   static async create({ productId, productName, materials }, io) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // ---- Product: resolve ID by name if only name is given ----
//       let finalProductId = productId;
//       let fetchedProductName = productName;
//       if (!finalProductId && productName) {
//         let result = await client.query(
//           'SELECT product_id FROM inventory WHERE LOWER(product_name) = LOWER($1)',
//           [productName.trim()]
//         );
//         if (result.rows.length) {
//           finalProductId = result.rows[0].product_id;
//         } else {
//           let insertRes = await client.query(
//             'INSERT INTO inventory (product_name) VALUES ($1) RETURNING product_id',
//             [productName.trim()]
//           );
//           finalProductId = insertRes.rows[0].product_id;
//         }
//       }
//       if (!fetchedProductName && finalProductId) {
//         let result = await client.query('SELECT product_name FROM inventory WHERE product_id = $1', [finalProductId]);
//         fetchedProductName = result.rows.length ? result.rows[0].product_name : '';
//       }
//       if (!finalProductId) throw new Error('Product could not be resolved or created');

//       // ---- Materials: resolve ID by name if only name is given ----
//       const resolvedMaterials = [];
//       for (const mat of materials) {
//         let materialId = mat.materialId;
//         let materialName = mat.materialName;
//         if (!materialId && materialName) {
//           let result = await client.query(
//             'SELECT product_id FROM raw_materials WHERE LOWER(product_name) = LOWER($1)',
//             [materialName.trim()]
//           );
//           if (result.rows.length) {
//             materialId = result.rows[0].product_id;
//           } else {
//             let insertRes = await client.query(
//               'INSERT INTO raw_materials (product_name) VALUES ($1) RETURNING product_id',
//               [materialName.trim()]
//             );
//             materialId = insertRes.rows[0].product_id;
//           }
//         }
//         if (!materialName && materialId) {
//           let result = await client.query('SELECT product_name FROM raw_materials WHERE product_id = $1', [materialId]);
//           materialName = result.rows.length ? result.rows[0].product_name : '';
//         }
//         if (!materialId) throw new Error('Material could not be resolved or created');
//         resolvedMaterials.push({
//           materialId,
//           materialName,
//           quantityPerUnit: mat.quantityPerUnit,
//         });
//       }

//       // -- Insert BOM main row --
//       const bomQuery = `
//         INSERT INTO bill_of_materials (product_id, created_at)
//         VALUES ($1, CURRENT_TIMESTAMP)
//         RETURNING 
//           bom_id AS "bomId",
//           product_id AS "productId",
//           created_at AS "createdAt",
//           updated_at AS "updatedAt"
//       `;
//       const bomResult = await client.query(bomQuery, [finalProductId]);
//       const bom = bomResult.rows[0];

//       // -- Insert all BOM materials --
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
//       const insertedMaterials = [];
//       for (const mat of resolvedMaterials) {
//         const materialResult = await client.query(materialQuery, [
//           bom.bomId,
//           mat.materialId,
//           mat.quantityPerUnit
//         ]);
//         insertedMaterials.push({
//           ...materialResult.rows[0],
//           materialName: mat.materialName
//         });
//       }

//       await client.query('COMMIT');

//       const response = {
//         ...bom,
//         productName: fetchedProductName,
//         materials: insertedMaterials
//       };
//       io?.emit('bom:created', response);
//       return response;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw new Error(`Error creating BOM: ${error.message}`);
//     } finally {
//       client.release();
//     }
//   }

//   static async update(bomId, { productId, productName, materials }, io) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       let finalProductId = productId;
//       let fetchedProductName = productName;
//       if (!finalProductId && productName) {
//         let result = await client.query(
//           'SELECT product_id FROM inventory WHERE LOWER(product_name) = LOWER($1)',
//           [productName.trim()]
//         );
//         if (result.rows.length) {
//           finalProductId = result.rows[0].product_id;
//         } else {
//           let insertRes = await client.query(
//             'INSERT INTO inventory (product_name) VALUES ($1) RETURNING product_id',
//             [productName.trim()]
//           );
//           finalProductId = insertRes.rows[0].product_id;
//         }
//       }
//       if (!fetchedProductName && finalProductId) {
//         let result = await client.query('SELECT product_name FROM inventory WHERE product_id = $1', [finalProductId]);
//         fetchedProductName = result.rows.length ? result.rows[0].product_name : '';
//       }
//       if (!finalProductId) throw new Error('Product could not be resolved or created');

//       // Resolve materials
//       const resolvedMaterials = [];
//       for (const mat of materials) {
//         let materialId = mat.materialId;
//         let materialName = mat.materialName;
//         if (!materialId && materialName) {
//           let result = await client.query(
//             'SELECT product_id FROM raw_materials WHERE LOWER(product_name) = LOWER($1)',
//             [materialName.trim()]
//           );
//           if (result.rows.length) {
//             materialId = result.rows[0].product_id;
//           } else {
//             let insertRes = await client.query(
//               'INSERT INTO raw_materials (product_name) VALUES ($1) RETURNING product_id',
//               [materialName.trim()]
//             );
//             materialId = insertRes.rows[0].product_id;
//           }
//         }
//         if (!materialName && materialId) {
//           let result = await client.query('SELECT product_name FROM raw_materials WHERE product_id = $1', [materialId]);
//           materialName = result.rows.length ? result.rows[0].product_name : '';
//         }
//         if (!materialId) throw new Error('Material could not be resolved or created');
//         resolvedMaterials.push({
//           materialId,
//           materialName,
//           quantityPerUnit: mat.quantityPerUnit,
//         });
//       }

//       // -- Update BOM row --
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
//       const bomResult = await client.query(bomQuery, [finalProductId, bomId]);
//       if (bomResult.rows.length === 0) {
//         throw new Error(`BOM ${bomId} not found`);
//       }
//       const bom = bomResult.rows[0];

//       // -- Remove old materials --
//       await client.query('DELETE FROM bom_materials WHERE bom_id = $1', [bomId]);

//       // -- Insert new materials --
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
//       const insertedMaterials = [];
//       for (const mat of resolvedMaterials) {
//         const materialResult = await client.query(materialQuery, [
//           bomId,
//           mat.materialId,
//           mat.quantityPerUnit
//         ]);
//         insertedMaterials.push({
//           ...materialResult.rows[0],
//           materialName: mat.materialName
//         });
//       }

//       await client.query('COMMIT');

//       const response = {
//         ...bom,
//         productName: fetchedProductName,
//         materials: insertedMaterials
//       };
//       io?.emit('bom:updated', response);
//       return response;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw new Error(`Error updating BOM ${bomId}: ${error.message}`);
//     } finally {
//       client.release();
//     }
//   }

//   // ... getAll, getById, delete ... unchanged ...
// }

// module.exports = BOM;
