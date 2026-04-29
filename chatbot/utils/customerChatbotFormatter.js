function formatCustomerList(title, customers) {
  if (!customers || customers.length === 0) return `${title}:\nNo customers found.`;
  const lines = customers.map((c) => {
    const orders = c.total_orders !== undefined ? ` — ${c.total_orders} order(s)` : '';
    const city = c.city ? ` (${c.city})` : '';
    return `**${c.name}**${city}${orders}`;
  });
  return `${title}:\n${lines.join('\n')}`;
}

function formatCustomerCount(stats) {
  return `Customer Summary:\n**Total Customers:** ${stats.total_customers}`;
}

function formatCityBreakdown(rows) {
  if (!rows || rows.length === 0) return `Customers by City:\nNo data found.`;
  const lines = rows.map((r) => `**${r.city}**: ${r.customer_count} customer(s)`);
  return `Customers by City:\n${lines.join('\n')}`;
}

function formatOrderBreakdown(rows) {
  if (!rows || rows.length === 0) return `Customer Order Breakdown:\nNo data found.`;
  const lines = rows.map(
    (r) => `**${r.status}**: ${r.order_count} order(s) across ${r.customer_count} customer(s)`
  );
  return `Customer Order Breakdown by Status:\n${lines.join('\n')}`;
}

module.exports = { formatCustomerList, formatCustomerCount, formatCityBreakdown, formatOrderBreakdown };
