import zlib from "node:zlib";

export interface SourceParseResult {
  sourceType: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SourceProvider {
  id: string;
  label: string;
  extensions: string[];
  phase: "docs-index";
  describe(): string;
  parse(filePath: string, content: Buffer): Promise<SourceParseResult>;
}

export class SourceRegistry {
  private readonly providers = new Map<string, SourceProvider>();

  register(provider: SourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Source provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  list(): SourceProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): SourceProvider | undefined {
    return this.providers.get(id);
  }

  findByExtension(extension: string): SourceProvider | undefined {
    const normalized = extension.toLowerCase();
    return this.list().find((provider) => provider.extensions.includes(normalized));
  }
}

export function createSourceProvider(id: string, label: string, extensions: string[]): SourceProvider {
  return {
    id,
    label,
    extensions,
    phase: "docs-index",
    describe: () => `${label} source provider.`,
    parse: async (_filePath, content) => ({
      sourceType: id,
      text: content.toString("utf8"),
      metadata: {}
    })
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function stripXmlTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim();
}

function inflateZipEntry(buffer: Buffer, fileName: string, compressionMethod: number, dataStart: number, compressedSize: number): Buffer | undefined {
  const dataEnd = dataStart + compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) return undefined;
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (compressionMethod === 8) {
    try {
      return zlib.inflateRawSync(compressed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to inflate ${fileName}: ${reason}`);
    }
  }
  return undefined;
}

function readZipEntriesFromCentralDirectory(buffer: Buffer): Map<string, Buffer> | undefined {
  const entries = new Map<string, Buffer>();
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return undefined;

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8").replace(/\\/g, "/");

    if (localHeaderOffset + 30 <= buffer.length && buffer.readUInt32LE(localHeaderOffset) === 0x04034b50) {
      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const data = inflateZipEntry(buffer, fileName, compressionMethod, dataStart, compressedSize);
      if (data) entries.set(fileName, data);
    }

    offset = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return entries.size > 0 ? entries : undefined;
}

function readZipEntriesFromLocalHeaders(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const dataStart = fileNameStart + fileNameLength + extraLength;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8");
    const data = inflateZipEntry(buffer, fileName, compressionMethod, dataStart, compressedSize);

    if (data) entries.set(fileName.replace(/\\/g, "/"), data);
    offset = dataStart + compressedSize;
  }

  return entries;
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  return readZipEntriesFromCentralDirectory(buffer) ?? readZipEntriesFromLocalHeaders(buffer);
}

function docxToText(content: Buffer): string {
  const entries = readZipEntries(content);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) return "";
  return documentXml
    .toString("utf8")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\r?\n/)
    .map((line) => decodeXml(line).replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function xlsxSharedStrings(entries: Map<string, Buffer>): string[] {
  const sharedStringsXml = entries.get("xl/sharedStrings.xml");
  if (!sharedStringsXml) return [];
  const xml = sharedStringsXml.toString("utf8");
  const strings: string[] = [];
  const itemRegex = /<si\b[\s\S]*?<\/si>/g;
  const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  for (const item of xml.match(itemRegex) ?? []) {
    const parts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = textRegex.exec(item)) !== null) {
      parts.push(decodeXml(match[1]));
    }
    strings.push(parts.join(""));
  }
  return strings;
}

function xlsxToText(content: Buffer): string {
  const entries = readZipEntries(content);
  const sharedStrings = xlsxSharedStrings(entries);
  const sheetNames = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort();
  const rows: string[] = [];

  for (const sheetName of sheetNames) {
    const xml = entries.get(sheetName)?.toString("utf8") ?? "";
    rows.push(`# ${sheetName}`);
    const rowRegex = /<row\b[\s\S]*?<\/row>/g;
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    const valueRegex = /<v>([\s\S]*?)<\/v>/;
    for (const rowXml of xml.match(rowRegex) ?? []) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const rawValue = valueRegex.exec(body)?.[1] ?? stripXmlTags(body);
        if (attrs.includes('t="s"')) {
          const index = Number.parseInt(rawValue, 10);
          cells.push(Number.isFinite(index) ? sharedStrings[index] ?? rawValue : rawValue);
        } else {
          cells.push(decodeXml(rawValue));
        }
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t"));
    }
  }

  return rows.filter(Boolean).join("\n");
}

export function createDefaultSourceRegistry(): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register({
    id: "docx",
    label: "Word document",
    extensions: [".docx"],
    phase: "docs-index",
    describe: () => "Word document source provider.",
    parse: async (_filePath, content) => ({
      sourceType: "docx",
      text: docxToText(content),
      metadata: {}
    })
  });
  registry.register({
    id: "xlsx",
    label: "Excel workbook",
    extensions: [".xlsx"],
    phase: "docs-index",
    describe: () => "Excel workbook source provider.",
    parse: async (_filePath, content) => ({
      sourceType: "xlsx",
      text: xlsxToText(content),
      metadata: {}
    })
  });
  return registry;
}
