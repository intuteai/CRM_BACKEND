// Input validation for the raw-materials stock API (/api/stock).
//
// Every limit here mirrors the raw_materials columns, so a bad value gets a 400
// that names the field instead of a database error turning into a generic 500:
//   product_name varchar(100), product_code varchar(50) (we require exactly 11),
//   location varchar(100), price / stock_quantity / returnable_qty numeric(10,2),
//   qty_required integer.

const NUMERIC_10_2_MAX = 99999999.99;
const INT_MAX = 2147483647;

const LIMITS = Object.freeze({
  productName: 100,
  location: 100,
  description: 5000,
  imageUrl: 2000,
  reason: 500,
});

// NNNN (part number) + 2-char chart pair + 2-char sub code + store, column, row.
// Every existing row matches this and the code builder can only produce it.
const PRODUCT_CODE_RE = /^\d{4}[A-Z0-9]{4}\d{3}$/;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// numeric(10,2) keeps two decimals; round here so what we compare is what is stored.
const round2 = (n) => Math.round(n * 100) / 100;

function checkAmount(errors, body, field, label, { required = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null) {
    if (required) errors.push({ field, message: `${label} is required` });
    return undefined;
  }
  if (!isFiniteNumber(v)) {
    errors.push({ field, message: `${label} must be a number` });
    return undefined;
  }
  if (v < 0) {
    errors.push({ field, message: `${label} cannot be negative` });
    return undefined;
  }
  if (v > NUMERIC_10_2_MAX) {
    errors.push({ field, message: `${label} is too large (max ${NUMERIC_10_2_MAX})` });
    return undefined;
  }
  return round2(v);
}

// undefined = not sent (keep), null or '' = clear, otherwise trimmed text.
function checkOptionalText(errors, body, field, label, max) {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field, message: `${label} must be text` });
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed.length > max) {
    errors.push({ field, message: `${label} is too long (max ${max} characters)` });
    return undefined;
  }
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate a create (POST /) or update (PUT /:productId) body.
 * Name, code and price are always required. Every other field is optional:
 * on update a field that is left out keeps its stored value.
 *
 * Returns { errors: [{field, message}], value } where value holds only the
 * fields that were sent, already trimmed / upper-cased / rounded.
 */
function validateStockBody(body) {
  const errors = [];
  const value = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
  }

  if (typeof body.productName !== 'string' || body.productName.trim() === '') {
    errors.push({ field: 'productName', message: 'Product name is required' });
  } else if (body.productName.trim().length > LIMITS.productName) {
    errors.push({ field: 'productName', message: `Product name is too long (max ${LIMITS.productName} characters)` });
  } else {
    value.productName = body.productName.trim();
  }

  if (typeof body.productCode !== 'string' || body.productCode.trim() === '') {
    errors.push({ field: 'productCode', message: 'Product code is required' });
  } else {
    const code = body.productCode.trim().toUpperCase();
    if (code.length !== 11) {
      errors.push({ field: 'productCode', message: 'Product code must be exactly 11 characters' });
    } else if (!PRODUCT_CODE_RE.test(code)) {
      errors.push({
        field: 'productCode',
        message: 'Product code must be 4 digits, 4 letters/digits, then 3 digits (e.g. 0042L5BR123)',
      });
    } else {
      value.productCode = code;
    }
  }

  const price = checkAmount(errors, body, 'price', 'Price', { required: true });
  if (price !== undefined) value.price = price;

  const stock = checkAmount(errors, body, 'stockQuantity', 'Stock quantity');
  if (stock !== undefined) value.stockQuantity = stock;

  const returnable = checkAmount(errors, body, 'returnableQty', 'Returnable quantity');
  if (returnable !== undefined) value.returnableQty = returnable;

  if (body.qtyRequired !== undefined && body.qtyRequired !== null) {
    const q = body.qtyRequired;
    if (!Number.isInteger(q) || q < 0 || q > INT_MAX) {
      errors.push({ field: 'qtyRequired', message: 'Qty required must be a whole number of 0 or more' });
    } else {
      value.qtyRequired = q;
    }
  }

  const description = checkOptionalText(errors, body, 'description', 'Description', LIMITS.description);
  if (description !== undefined) value.description = description;

  const location = checkOptionalText(errors, body, 'location', 'Location', LIMITS.location);
  if (location !== undefined) value.location = location;

  const imageUrl = checkOptionalText(errors, body, 'imageUrl', 'Image URL', LIMITS.imageUrl);
  if (imageUrl !== undefined) value.imageUrl = imageUrl;

  const reason = checkOptionalText(errors, body, 'stockChangeReason', 'Reason', LIMITS.reason);
  if (reason !== undefined) value.stockChangeReason = reason;

  if (body.part_number_auto !== undefined && body.part_number_auto !== null && typeof body.part_number_auto !== 'boolean') {
    errors.push({ field: 'part_number_auto', message: 'part_number_auto must be true or false' });
  } else {
    value.partNumberAuto = body.part_number_auto === true;
  }

  return { errors, value };
}

/** POST /:productId/adjust: quantity is a signed, non-zero change. */
function validateAdjustBody(body) {
  const errors = [];
  const value = {};
  const src = body && typeof body === 'object' ? body : {};
  const q = src.quantity;
  if (!isFiniteNumber(q)) {
    errors.push({ field: 'quantity', message: 'Quantity must be a number' });
  } else if (round2(q) === 0) {
    errors.push({ field: 'quantity', message: 'Quantity cannot be zero' });
  } else if (Math.abs(q) > NUMERIC_10_2_MAX) {
    errors.push({ field: 'quantity', message: 'Quantity is too large' });
  } else {
    value.quantity = round2(q);
  }
  const reason = checkOptionalText(errors, src, 'reason', 'Reason', LIMITS.reason);
  if (reason !== undefined) value.reason = reason;
  return { errors, value };
}

/** POST /:productId/accept-return: quantity is a positive amount. */
function validateAcceptReturnBody(body) {
  const errors = [];
  const value = {};
  const q = body && typeof body === 'object' ? body.quantity : undefined;
  if (!isFiniteNumber(q) || round2(q) <= 0) {
    errors.push({ field: 'quantity', message: 'Quantity to accept must be a number greater than 0' });
  } else if (q > NUMERIC_10_2_MAX) {
    errors.push({ field: 'quantity', message: 'Quantity is too large' });
  } else {
    value.quantity = round2(q);
  }
  return { errors, value };
}

/** Route param :productId → positive integer, or null when invalid. */
function parseProductId(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= INT_MAX ? n : null;
}

/** ?limit=&offset= → clamped integers. */
function parsePaging(query, { defaultLimit = 10, maxLimit = 10000 } = {}) {
  const lim = parseInt(query && query.limit, 10);
  const off = parseInt(query && query.offset, 10);
  return {
    limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, maxLimit) : defaultLimit,
    offset: Number.isFinite(off) && off > 0 ? off : 0,
  };
}

module.exports = {
  NUMERIC_10_2_MAX,
  INT_MAX,
  LIMITS,
  PRODUCT_CODE_RE,
  round2,
  validateStockBody,
  validateAdjustBody,
  validateAcceptReturnBody,
  parseProductId,
  parsePaging,
};
