const { CustomerChatbot } = require('../models/customer');
const { detectIntent } = require('../utils/customerChatbotIntents');
const {
  formatCustomerList,
  formatCustomerCount,
  formatCityBreakdown,
  formatOrderBreakdown,
} = require('../utils/customerChatbotFormatter');

class CustomerChatbotService {
  static async handle(message) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try: "show all customers", "show top customers by orders", "show customers by city", or "count total customers".`,
      };
    }

    const handlers = {
      CUSTOMER_LIST_ALL:        () => CustomerChatbot.getAllForChatbot(10),
      CUSTOMER_LIST_RECENT:     () => CustomerChatbot.getRecentForChatbot(10),
      CUSTOMER_COUNT:           () => CustomerChatbot.countForChatbot(),
      CUSTOMER_TOP_BY_ORDERS:   () => CustomerChatbot.getTopByOrdersForChatbot(10),
      CUSTOMER_NO_ORDERS:       () => CustomerChatbot.getWithNoOrdersForChatbot(10),
      CUSTOMER_BY_CITY:         () => CustomerChatbot.getByCityForChatbot(),
      CUSTOMER_ORDER_BREAKDOWN: () => CustomerChatbot.getOrderStatusBreakdownForChatbot(),
    };

    const data = await handlers[intent]();

    let response;
    switch (intent) {
      case 'CUSTOMER_COUNT':
        response = formatCustomerCount(data);
        return { success: true, response, data: null };
      case 'CUSTOMER_BY_CITY':
        response = formatCityBreakdown(data);
        return { success: true, response, data };
      case 'CUSTOMER_ORDER_BREAKDOWN':
        response = formatOrderBreakdown(data);
        return { success: true, response, data };
      case 'CUSTOMER_LIST_ALL':
        response = formatCustomerList('All customers', data);
        break;
      case 'CUSTOMER_LIST_RECENT':
        response = formatCustomerList('Recently added customers', data);
        break;
      case 'CUSTOMER_TOP_BY_ORDERS':
        response = formatCustomerList('Top customers by orders', data);
        break;
      case 'CUSTOMER_NO_ORDERS':
        response = formatCustomerList('Customers with no orders', data);
        break;
      default:
        response = formatCustomerList('Customers', data);
    }

    return { success: true, response, data };
  }
}

module.exports = { CustomerChatbotService };
