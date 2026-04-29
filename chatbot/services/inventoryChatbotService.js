const { InventoryChatbot } = require('../models/inventory');
const { detectIntent } = require('../utils/inventoryChatbotIntents');
const {
  formatProductList,
  formatInventoryCount,
  formatInventoryValue,
} = require('../utils/inventoryChatbotFormatter');

class InventoryChatbotService {
  static async handle(message) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try: "show all products", "show low stock products", "show out of stock products", or "show inventory value".`,
      };
    }

    const handlers = {
      INVENTORY_LIST_ALL:    () => InventoryChatbot.getAllForChatbot(10),
      INVENTORY_LOW_STOCK:   () => InventoryChatbot.getLowStockForChatbot(10, 10),
      INVENTORY_OUT_OF_STOCK:() => InventoryChatbot.getOutOfStockForChatbot(10),
      INVENTORY_COUNT:       () => InventoryChatbot.countForChatbot(),
      INVENTORY_TOP_BY_STOCK:() => InventoryChatbot.getTopByStockForChatbot(10),
      INVENTORY_WITH_HOLDS:  () => InventoryChatbot.getWithActiveHoldsForChatbot(10),
      INVENTORY_VALUE:       () => InventoryChatbot.getInventoryValueForChatbot(),
    };

    const data = await handlers[intent]();

    let response;
    switch (intent) {
      case 'INVENTORY_COUNT':
        response = formatInventoryCount(data);
        return { success: true, response, data: null };
      case 'INVENTORY_VALUE':
        response = formatInventoryValue(data);
        return { success: true, response, data: null };
      case 'INVENTORY_LIST_ALL':
        response = formatProductList('All products', data);
        break;
      case 'INVENTORY_LOW_STOCK':
        response = formatProductList('Low stock products (≤10 units)', data);
        break;
      case 'INVENTORY_OUT_OF_STOCK':
        response = formatProductList('Out of stock products', data);
        break;
      case 'INVENTORY_TOP_BY_STOCK':
        response = formatProductList('Top products by stock quantity', data);
        break;
      case 'INVENTORY_WITH_HOLDS':
        response = formatProductList('Products with active holds (reserved)', data);
        break;
      default:
        response = formatProductList('Products', data);
    }

    return { success: true, response, data };
  }
}

module.exports = { InventoryChatbotService };
