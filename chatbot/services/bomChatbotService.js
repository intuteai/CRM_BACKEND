const { BOMChatbot } = require('../models/bom');
const { detectIntent } = require('../utils/bomChatbotIntents');
const { formatBOMList, formatBOMCount } = require('../utils/bomChatbotFormatter');

class BOMChatbotService {
  static async handle(message) {
    const intent = detectIntent(message);

    if (!intent) {
      return {
        success: false,
        response: `I didn't understand that. Try: "show all boms", "count total boms", "show most complex boms", or "show high value boms".`,
      };
    }

    const handlers = {
      BOM_LIST_ALL:     () => BOMChatbot.getAllForChatbot(10),
      BOM_COUNT:        () => BOMChatbot.countForChatbot(),
      BOM_MOST_COMPLEX: () => BOMChatbot.getMostComplexForChatbot(10),
      BOM_RECENT:       () => BOMChatbot.getRecentlyUpdatedForChatbot(10),
      BOM_HIGH_VALUE:   () => BOMChatbot.getHighValueForChatbot(10),
    };

    const data = await handlers[intent]();

    let response;
    switch (intent) {
      case 'BOM_COUNT':
        response = formatBOMCount(data);
        return { success: true, response, data: null };
      case 'BOM_LIST_ALL':
        response = formatBOMList('All BOMs', data);
        break;
      case 'BOM_MOST_COMPLEX':
        response = formatBOMList('Most complex BOMs (most materials)', data);
        break;
      case 'BOM_RECENT':
        response = formatBOMList('Recently updated BOMs', data);
        break;
      case 'BOM_HIGH_VALUE':
        response = formatBOMList('Highest value BOMs', data);
        break;
      default:
        response = formatBOMList('BOMs', data);
    }

    return { success: true, response, data };
  }
}

module.exports = { BOMChatbotService };
