const { RawMaterialChatbot } = require('../models/rawMaterial');
const { detectIntent } = require('../utils/rawMaterialChatbotIntents');
const {
  formatMaterialList,
  formatStockCount,
  formatLocationBreakdown,
  formatMaterialValue,
} = require('../utils/rawMaterialChatbotFormatter');

class RawMaterialChatbotService {
  static async handle(message) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try: "show all raw materials", "show low raw materials", "show most needed materials", or "show raw material value".`,
      };
    }

    const handlers = {
      STOCK_LIST_ALL:    () => RawMaterialChatbot.getAllForChatbot(10),
      STOCK_LOW:         () => RawMaterialChatbot.getLowStockForChatbot(10),
      STOCK_OUT_OF_STOCK:() => RawMaterialChatbot.getOutOfStockForChatbot(10),
      STOCK_COUNT:       () => RawMaterialChatbot.countForChatbot(),
      STOCK_BY_LOCATION: () => RawMaterialChatbot.getByLocationForChatbot(),
      STOCK_MOST_NEEDED: () => RawMaterialChatbot.getMostNeededForChatbot(10),
      STOCK_VALUE:       () => RawMaterialChatbot.getMaterialValueForChatbot(),
    };

    const data = await handlers[intent]();

    let response;
    switch (intent) {
      case 'STOCK_COUNT':
        response = formatStockCount(data);
        return { success: true, response, data: null };
      case 'STOCK_BY_LOCATION':
        response = formatLocationBreakdown(data);
        return { success: true, response, data };
      case 'STOCK_VALUE':
        response = formatMaterialValue(data);
        return { success: true, response, data: null };
      case 'STOCK_LIST_ALL':
        response = formatMaterialList('All raw materials', data);
        break;
      case 'STOCK_LOW':
        response = formatMaterialList('Raw materials below required quantity', data);
        break;
      case 'STOCK_OUT_OF_STOCK':
        response = formatMaterialList('Out of stock raw materials', data);
        break;
      case 'STOCK_MOST_NEEDED':
        response = formatMaterialList('Most needed raw materials (largest shortfall)', data);
        break;
      default:
        response = formatMaterialList('Raw materials', data);
    }

    return { success: true, response, data };
  }
}

module.exports = { RawMaterialChatbotService };
