function formatBOMList(title, boms) {
  if (!boms || boms.length === 0) return `${title}:\nNo BOMs found.`;
  const lines = boms.map((b) => {
    const code = b.product_code ? ` [${b.product_code}]` : '';
    const value = b.total_bom_value
      ? ` — Value: ₹${Number(b.total_bom_value).toLocaleString('en-IN')}`
      : '';
    const date = b.updated_at ? ` (Updated: ${b.updated_at})` : b.created_at ? ` (Created: ${b.created_at})` : '';
    return `**${b.product_name || 'Unnamed'}**${code} — ${b.material_count} material(s)${value}${date}`;
  });
  return `${title}:\n${lines.join('\n')}`;
}

function formatBOMCount(stats) {
  return `BOM Summary:\n**Total BOMs:** ${stats.total_boms}\n**Total Materials Used:** ${stats.total_materials_used}\n**Total BOM Value:** ₹${Number(stats.total_value).toLocaleString('en-IN')}`;
}

module.exports = { formatBOMList, formatBOMCount };
