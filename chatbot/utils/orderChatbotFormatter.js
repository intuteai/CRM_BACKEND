function formatOrders(title, orders) {
  if (!orders || orders.length === 0) {
    return `${title}:\nNo orders found.`;
  }

  const lines = orders.map(
    (o) => `Order ${o.order_id} - Customer: ${o.customer_name} - ${o.status}`
  );

  return `${title}:\n${lines.join('\n')}`;
}

function formatOrderStatusCounts(title, counts) {
  if (!counts || counts.length === 0) {
    return `${title}:\nNo orders found.`;
  }

  const lines = counts.map(
    (item) => `${item.status}: ${item.count}`
  );

  return `${title}:\n${lines.join('\n')}`;
}

module.exports = {
  formatOrders,
  formatOrderStatusCounts,
};
