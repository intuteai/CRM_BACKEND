function formatMaterialList(title, materials) {
  if (!materials || materials.length === 0) return `${title}:\nNo materials found.`;
  const lines = materials.map((m) => {
    const code = m.product_code ? ` [${m.product_code}]` : '';
    const location = m.location ? ` @ ${m.location}` : '';
    const required = m.qty_required !== undefined ? ` | Required: ${m.qty_required}` : '';
    const shortfall = m.shortfall !== undefined ? ` | Shortfall: ${m.shortfall}` : '';
    return `**${m.product_name}**${code} — Stock: ${m.stock_quantity}${required}${shortfall}${location}`;
  });
  return `${title}:\n${lines.join('\n')}`;
}

function formatStockCount(stats) {
  return `Raw Materials Summary:\n**Total Materials:** ${stats.total_materials}\n**Total Stock Units:** ${stats.total_stock}\n**Out of Stock:** ${stats.out_of_stock}\n**Below Required:** ${stats.below_required}`;
}

function formatLocationBreakdown(rows) {
  if (!rows || rows.length === 0) return `Materials by Location:\nNo data found.`;
  const lines = rows.map((r) => `**${r.location}**: ${r.material_count} material(s), ${r.total_stock} units`);
  return `Raw Materials by Location:\n${lines.join('\n')}`;
}

function formatMaterialValue(stats) {
  return `Raw Material Value Summary:\n**Total Materials:** ${stats.total_materials}\n**Total Units:** ${stats.total_units}\n**Total Value:** ₹${Number(stats.total_value).toLocaleString('en-IN')}\n**Average Price:** ₹${Number(stats.avg_price).toLocaleString('en-IN')}`;
}

module.exports = { formatMaterialList, formatStockCount, formatLocationBreakdown, formatMaterialValue };
