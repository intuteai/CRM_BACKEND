const INTENTS = {
  'show all orders':                  'ORDER_LIST_ALL',
  'show recent orders':               'ORDER_LIST_RECENT',
  'show pending orders':              'ORDER_LIST_PENDING',
  'show processing orders':           'ORDER_LIST_PROCESSING',
  'show testing orders':              'ORDER_LIST_TESTING',
  'show ready for shipment orders':   'ORDER_LIST_READY_FOR_SHIPMENT',
  'show shipped orders':              'ORDER_LIST_SHIPPED',
  'show partially delivered orders':  'ORDER_LIST_PARTIALLY_DELIVERED',
  'show delivered orders':            'ORDER_LIST_DELIVERED',
  'show cancelled orders':            'ORDER_LIST_CANCELLED',
  'count orders by status':           'ORDER_COUNT_BY_STATUS',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
