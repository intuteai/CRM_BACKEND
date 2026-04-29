const INTENTS = {
  'show all raw materials':            'STOCK_LIST_ALL',
  'show low raw materials':            'STOCK_LOW',
  'show out of stock raw materials':   'STOCK_OUT_OF_STOCK',
  'count total raw materials':         'STOCK_COUNT',
  'show materials by location':        'STOCK_BY_LOCATION',
  'show most needed materials':        'STOCK_MOST_NEEDED',
  'show raw material value':           'STOCK_VALUE',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
