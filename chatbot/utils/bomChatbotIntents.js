const INTENTS = {
  'show all boms':              'BOM_LIST_ALL',
  'count total boms':           'BOM_COUNT',
  'show most complex boms':     'BOM_MOST_COMPLEX',
  'show recently updated boms': 'BOM_RECENT',
  'show high value boms':       'BOM_HIGH_VALUE',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
