const INTENTS = {
  'show all products':             'INVENTORY_LIST_ALL',
  'show low stock products':       'INVENTORY_LOW_STOCK',
  'show out of stock products':    'INVENTORY_OUT_OF_STOCK',
  'count total products':          'INVENTORY_COUNT',
  'show top products by stock':    'INVENTORY_TOP_BY_STOCK',
  'show products with holds':      'INVENTORY_WITH_HOLDS',
  'show inventory value':          'INVENTORY_VALUE',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
