function formatProductList(title, products) {
  if (!products || products.length === 0) return `${title}:\nNo products found.`;
  const lines = products.map((p) => {
    const code = p.product_code ? ` [${p.product_code}]` : '';
    const price = p.price ? ` — ₹${Number(p.price).toLocaleString('en-IN')}` : '';
    const reserved = p.reserved_qty !== undefined ? ` | Reserved: ${p.reserved_qty} | Available: ${p.available_qty}` : '';
    return `**${p.product_name}**${code} — Stock: ${p.stock_quantity}${reserved}${price}`;
  });
  return `${title}:\n${lines.join('\n')}`;
}

function formatInventoryCount(stats) {
  return `Inventory Summary:\n**Total Products:** ${stats.total_products}\n**Total Stock Units:** ${stats.total_stock}\n**Out of Stock:** ${stats.out_of_stock}\n**Low Stock (≤10):** ${stats.low_stock}`;
}

function formatInventoryValue(stats) {
  return `Inventory Value Summary:\n**Total Products:** ${stats.total_products}\n**Total Units:** ${stats.total_units}\n**Total Value:** ₹${Number(stats.total_value).toLocaleString('en-IN')}\n**Average Price:** ₹${Number(stats.avg_price).toLocaleString('en-IN')}`;
}

module.exports = { formatProductList, formatInventoryCount, formatInventoryValue };
