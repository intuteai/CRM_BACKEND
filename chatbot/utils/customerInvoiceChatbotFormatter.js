function formatInvoiceList(title, invoices) {
  if (!invoices || invoices.length === 0) return `${title}:\nNo invoices found.`;
  const lines = invoices.map(
    (inv) => `**${inv.invoice_number}** - ${inv.customer_name} - ₹${Number(inv.total_value).toLocaleString('en-IN')} (${inv.issue_date})`
  );
  return `${title}:\n${lines.join('\n')}`;
}

function formatInvoiceCount(stats) {
  return `Invoice Summary:\n**Total Invoices:** ${stats.total_invoices}\n**Total Value:** ₹${Number(stats.total_value).toLocaleString('en-IN')}`;
}

function formatInvoiceValueSummary(stats) {
  return `Invoice Value Analysis:\n**Total Invoices:** ${stats.total_invoices}\n**Total Value:** ₹${Number(stats.total_value).toLocaleString('en-IN')}\n**Average Value:** ₹${Number(stats.avg_value).toLocaleString('en-IN')}\n**Highest Invoice:** ₹${Number(stats.max_value).toLocaleString('en-IN')}\n**Lowest Invoice:** ₹${Number(stats.min_value).toLocaleString('en-IN')}`;
}

function formatMonthlyTrend(rows) {
  if (!rows || rows.length === 0) return `Monthly Invoice Trend:\nNo data available for the last 6 months.`;
  const lines = rows.map(
    (r) => `**${r.month}**: ${r.invoice_count} invoice(s) — ₹${Number(r.total_value).toLocaleString('en-IN')}`
  );
  return `Monthly Invoice Trend (Last 6 Months):\n${lines.join('\n')}`;
}

module.exports = { formatInvoiceList, formatInvoiceCount, formatInvoiceValueSummary, formatMonthlyTrend };
