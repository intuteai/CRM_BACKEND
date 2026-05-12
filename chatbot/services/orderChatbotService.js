const { Order } = require('../models/order');
const { detectIntent } = require('../utils/orderChatbotIntents');
const { formatOrders, formatOrderStatusCounts } = require('../utils/orderChatbotFormatter');

class OrderChatbotService {
  static async handle(message, user) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try commands like "show all orders", "show pending orders", "show ready for shipment orders", "show partially delivered orders", or "count orders by status".`,
      };
    }

    const handlers = {
      ORDER_LIST_ALL:                () => Order.getAllOrdersForChatbot(10),
      ORDER_LIST_RECENT:             () => Order.getAllOrdersForChatbot(5),
      ORDER_LIST_PENDING:            () => Order.getOrdersByStatusForChatbot('Pending'),
      ORDER_LIST_PROCESSING:         () => Order.getOrdersByStatusForChatbot('Processing'),
      ORDER_LIST_TESTING:            () => Order.getOrdersByStatusForChatbot('Testing'),
      ORDER_LIST_READY_FOR_SHIPMENT: () => Order.getOrdersByStatusForChatbot('Ready for Shipment'),
      ORDER_LIST_SHIPPED:            () => Order.getOrdersByStatusForChatbot('Shipped'),
      ORDER_LIST_PARTIALLY_DELIVERED:() => Order.getOrdersByStatusForChatbot('Partially Delivered'),
      ORDER_LIST_DELIVERED:          () => Order.getOrdersByStatusForChatbot('Delivered'),
      ORDER_LIST_CANCELLED:          () => Order.getOrdersByStatusForChatbot('Cancelled'),
      ORDER_COUNT_BY_STATUS:         () => Order.countOrdersByStatusForChatbot(),
    };

    const data = await handlers[intent]();

    let response;
    if (intent === 'ORDER_COUNT_BY_STATUS') {
      response = formatOrderStatusCounts('Order counts by status', data);
    } else {
      const titles = {
        ORDER_LIST_ALL:                 'All recent orders',
        ORDER_LIST_RECENT:              'Most recent orders',
        ORDER_LIST_PENDING:             'Pending orders',
        ORDER_LIST_PROCESSING:          'Processing orders',
        ORDER_LIST_TESTING:             'Testing orders',
        ORDER_LIST_READY_FOR_SHIPMENT:  'Ready for Shipment orders',
        ORDER_LIST_SHIPPED:             'Shipped orders',
        ORDER_LIST_PARTIALLY_DELIVERED: 'Partially Delivered orders',
        ORDER_LIST_DELIVERED:           'Delivered orders',
        ORDER_LIST_CANCELLED:           'Cancelled orders',
      };
      response = formatOrders(titles[intent], data);
    }

    return { success: true, response, data };
  }
}

module.exports = { OrderChatbotService };
