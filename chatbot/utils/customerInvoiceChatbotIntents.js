const INTENTS = {
  'show all invoices':        'INVOICE_LIST_ALL',
  'show recent invoices':     'INVOICE_LIST_RECENT',
  'count total invoices':     'INVOICE_COUNT',
  'show high value invoices': 'INVOICE_LIST_HIGH_VALUE',
  'show invoices this month': 'INVOICE_LIST_THIS_MONTH',
  'total invoice value':      'INVOICE_VALUE_SUMMARY',
  'show monthly invoice trend': 'INVOICE_MONTHLY_TREND',
};

function detectIntent(message) {
  if (!message || typeof message !== 'string') return null;
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  return INTENTS[normalized] || null;
}

module.exports = { detectIntent, INTENTS };
