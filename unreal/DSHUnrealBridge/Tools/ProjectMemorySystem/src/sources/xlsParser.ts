import * as XLSX from "@e965/xlsx";

export function parseXls(content: Buffer): { text: string; sheetNames: string[] } {
  const workbook = XLSX.read(content, {
    type: "buffer",
    bookVBA: false,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    dense: true,
    WTF: true
  });
  const lines: string[] = [];
  for (const name of workbook.SheetNames) {
    lines.push(`# ${name}`);
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const tabular = XLSX.utils.sheet_to_csv(sheet, { FS: "\t", RS: "\n", blankrows: false }).trim();
    if (tabular) lines.push(tabular);
  }
  if (!workbook.SheetNames.length) throw new Error("Excel workbook contains no worksheets.");
  return { text: lines.join("\n"), sheetNames: workbook.SheetNames };
}
