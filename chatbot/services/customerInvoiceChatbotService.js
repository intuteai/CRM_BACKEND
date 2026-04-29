const { CustomerInvoiceChatbot } = require('../models/customerInvoice');
const { detectIntent } = require('../utils/customerInvoiceChatbotIntents');
const {
  formatInvoiceList,
  formatInvoiceCount,
  formatInvoiceValueSummary,
  formatMonthlyTrend,
} = require('../utils/customerInvoiceChatbotFormatter');

class CustomerInvoiceChatbotService {
  static async handle(message) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try: "show all invoices", "show high value invoices", "total invoice value", or "show monthly invoice trend".`,
      };
    }

    const handlers = {
      INVOICE_LIST_ALL:       () => CustomerInvoiceChatbot.getAllForChatbot(10),
      INVOICE_LIST_RECENT:    () => CustomerInvoiceChatbot.getAllForChatbot(5),
      INVOICE_COUNT:          () => CustomerInvoiceChatbot.countForChatbot(),
      INVOICE_LIST_HIGH_VALUE:() => CustomerInvoiceChatbot.getHighValueForChatbot(50000, 10),
      INVOICE_LIST_THIS_MONTH:() => CustomerInvoiceChatbot.getThisMonthForChatbot(10),
      INVOICE_VALUE_SUMMARY:  () => CustomerInvoiceChatbot.getTotalValueSummaryForChatbot(),
      INVOICE_MONTHLY_TREND:  () => CustomerInvoiceChatbot.getMonthlyTrendForChatbot(),
    };

    const data = await handlers[intent]();

    let response;
    switch (intent) {
      case 'INVOICE_COUNT':
        response = formatInvoiceCount(data);
        return { success: true, response, data: null };
      case 'INVOICE_VALUE_SUMMARY':
        response = formatInvoiceValueSummary(data);
        return { success: true, response, data: null };
      case 'INVOICE_MONTHLY_TREND':
        response = formatMonthlyTrend(data);
        return { success: true, response, data };
      case 'INVOICE_LIST_ALL':
        response = formatInvoiceList('All recent invoices', data);
        break;
      case 'INVOICE_LIST_RECENT':
        response = formatInvoiceList('Most recent invoices', data);
        break;
      case 'INVOICE_LIST_HIGH_VALUE':
        response = formatInvoiceList('High value invoices (₹50,000+)', data);
        break;
      case 'INVOICE_LIST_THIS_MONTH':
        response = formatInvoiceList('Invoices this month', data);
        break;
      default:
        response = formatInvoiceList('Invoices', data);
    }

    return { success: true, response, data };
  }
}

module.exports = { CustomerInvoiceChatbotService };
