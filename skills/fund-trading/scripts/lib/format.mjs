export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char)
      ? 2
      : 1;
  }
  return width;
}

function padEndWidth(text, width) {
  const diff = width - displayWidth(text);
  return diff > 0 ? `${text}${" ".repeat(diff)}` : text;
}

export function table(rows, columns) {
  if (rows.length === 0) return "（无数据）";
  const widths = columns.map((col) =>
    Math.max(displayWidth(col.label), ...rows.map((row) => displayWidth(col.value(row) ?? ""))),
  );
  const header = columns.map((col, i) => padEndWidth(col.label, widths[i])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) =>
    columns.map((col, i) => padEndWidth(String(col.value(row) ?? ""), widths[i])).join("  "),
  );
  return [header, divider, ...body].join("\n");
}

export function money(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(2);
}

export function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${(Number(value) * 100).toFixed(2)}%`;
}

export function signed(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}
