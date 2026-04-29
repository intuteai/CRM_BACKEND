const INTENTS = {
  'show all customers':               'CUSTOMER_LIST_ALL',
  'show recent customers':            'CUSTOMER_LIST_RECENT',
  'count total customers':            'CUSTOMER_COUNT',
  'show top customers by orders':     'CUSTOMER_TOP_BY_ORDERS',
  'show customers with no orders':    'CUSTOMER_NO_ORDERS',
  'show customers by city':           'CUSTOMER_BY_CITY',
  'show customer order breakdown':    'CUSTOMER_ORDER_BREAKDOWN',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
