import * as cheerioModule from "cheerio";
import {
  Document, Packer, Paragraph, TextRun,
  AlignmentType, HeadingLevel,
  UnderlineType, Table, TableRow, TableCell,
  WidthType, Numbering, convertInchesToTwip
} from "docx";

interface RunFormat {
  bold?: boolean;
  italics?: boolean;
  underline?: { type: string; color?: string };
  strike?: boolean;
  font?: string;
  size?: number; // half-points
  color?: string;
  shading?: { fill: string; type: string };
  superScript?: boolean;
  subScript?: boolean;
}

function parseStyle(style: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!style) return result;
  style.split(";").forEach(p => {
    const [key, val] = p.split(":").map(s => s.trim());
    if (key && val) result[key.toLowerCase()] = val;
  });
  return result;
}

function parseSizeToHalfPoints(cssSize: string): number | undefined {
  const match = cssSize.match(/(\d+)(?:\.\d+)?\s*(pt|px)?/i);
  if (!match) return undefined;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "pt").toLowerCase();
  if (unit === "pt") return Math.round(num * 2);
  if (unit === "px") return Math.round((num * 3 / 4) * 2);
  return Math.round(num * 2);
}

function normalizeColor(cssColor: string): string {
  const c = cssColor.trim().replace(/&quot;/g, "");
  // Already hex or named color
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  // rgb(r, g, b) format
  const rgbMatch = c.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (rgbMatch) {
    const hex = [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])]
      .map(v => v.toString(16).padStart(2, "0").toUpperCase())
      .join("");
    return `#${hex}`;
  }
  // rgba(r, g, b, a) - strip alpha
  const rgbaMatch = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+).*?\)/i);
  if (rgbaMatch) {
    const hex = [parseInt(rgbaMatch[1]), parseInt(rgbaMatch[2]), parseInt(rgbaMatch[3])]
      .map(v => v.toString(16).padStart(2, "0").toUpperCase())
      .join("");
    return `#${hex}`;
  }
  // Return as-is for named colors or unknown formats
  return c;
}

function parseAlignment(cssAlign: string): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (cssAlign) {
    case "center": return AlignmentType.CENTER;
    case "right": return AlignmentType.RIGHT;
    case "left": return AlignmentType.LEFT;
    case "justify": return AlignmentType.JUSTIFIED;
    default: return undefined;
  }
}

function mergeFormats(base: RunFormat, overrides: RunFormat): RunFormat {
  return { ...base, ...overrides };
}

function extractRunFormat($el: any): RunFormat {
  const fmt: RunFormat = {};
  const tag = ($el[0] as any)?.tagName?.toLowerCase() || "";

  if (tag === "b" || tag === "strong") fmt.bold = true;
  if (tag === "i" || tag === "em") fmt.italics = true;
  if (tag === "u") fmt.underline = { type: UnderlineType.SINGLE };
  if (tag === "s" || tag === "strike" || tag === "del") fmt.strike = true;
  if (tag === "sup") fmt.superScript = true;
  if (tag === "sub") fmt.subScript = true;

  const style = parseStyle($el.attr("style") || "");
  if (style["font-family"]) {
    fmt.font = style["font-family"].replace(/["']/g, "").split(",")[0].trim();
  }
  if (style["font-size"]) {
    const size = parseSizeToHalfPoints(style["font-size"]);
    if (size) fmt.size = size;
  }
  if (style["color"]) {
    fmt.color = normalizeColor(style["color"]);
  }
  if (style["background-color"]) {
    const bg = normalizeColor(style["background-color"]);
    if (bg && bg !== "inherit" && bg !== "transparent") {
      fmt.shading = { fill: bg, type: "clear" };
    }
  }
  if (style["font-weight"] && (style["font-weight"] === "bold" || parseInt(style["font-weight"]) >= 700)) {
    fmt.bold = true;
  }
  if (style["font-style"] === "italic") fmt.italics = true;
  if (style["text-decoration"]) {
    if (style["text-decoration"].includes("underline")) fmt.underline = { type: UnderlineType.SINGLE };
    if (style["text-decoration"].includes("line-through")) fmt.strike = true;
  }

  return fmt;
}

function getBlockAlignment($el: any): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const style = parseStyle($el.attr("style") || "");
  if (style["text-align"]) return parseAlignment(style["text-align"]);
  if ($el.attr("align")) return parseAlignment($el.attr("align") || "");
  return undefined;
}

function collectTextRuns(
  $: any,
  $el: any,
  baseFormat: RunFormat
): TextRun[] {
  const runs: TextRun[] = [];
  const myFormat = mergeFormats(baseFormat, extractRunFormat($el));

  $el.contents().each((_: number, node: any) => {
    if (node.type === "text") {
      const text = (node as any).data || "";
      // Skip zero-width spaces
      const cleaned = text.replace(/​/g, "");
      if (cleaned) {
        const options: any = { text: cleaned };
        if (myFormat.bold) options.bold = true;
        if (myFormat.italics) options.italics = true;
        if (myFormat.underline) options.underline = myFormat.underline;
        if (myFormat.strike) options.strike = true;
        if (myFormat.font) options.font = myFormat.font;
        if (myFormat.size) options.size = myFormat.size;
        if (myFormat.color) options.color = myFormat.color;
        if (myFormat.shading) options.shading = myFormat.shading;
        if (myFormat.superScript) options.superScript = true;
        if (myFormat.subScript) options.subScript = true;
        runs.push(new TextRun(options));
      }
    } else if (node.type === "tag") {
      runs.push(...collectTextRuns($, $(node), myFormat));
    }
  });

  return runs;
}

function processTable($: any, $table: any): Table {
  const rows: TableRow[] = [];

  $table.find("tr").each((_: number, tr: any) => {
    const cells: TableCell[] = [];
    $(tr).find("td, th").each((_i: number, td: any) => {
      const paragraphs: Paragraph[] = [];
      const runs = collectTextRuns($, $(td), {});
      if (runs.length > 0) {
        paragraphs.push(new Paragraph({ children: runs }));
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun("")] }));
      }
      cells.push(new TableCell({ children: paragraphs }));
    });
    if (cells.length > 0) {
      rows.push(new TableRow({ children: cells }));
    }
  });

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function htmlToDocxBlocks($: any, $container: any): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];

  $container.children().each((_: number, el: any) => {
    const $el = $(el);
    const tag = (el as any)?.tagName || (el as any)?.name as string || "";

    if (tag === "table") {
      blocks.push(processTable($, $el));
      return;
    }

    if (tag === "ul" || tag === "ol") {
      const isOrdered = tag === "ol";
      const listRef = isOrdered ? "html-ordered" : "html-bullet";
      let instance = 0;
      $el.children("li").each((_i: number, li: any) => {
        const runs = collectTextRuns($, $(li), {});
        const options: any = {
          children: runs.length > 0 ? runs : [new TextRun("")],
          spacing: { after: 80, line: 276 },
        };
        if (isOrdered) {
          options.numbering = { reference: listRef, level: 0, instance };
        } else {
          options.bullet = { level: 0 };
        }
        blocks.push(new Paragraph(options));
        instance++;
      });
      return;
    }

    if (["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
      const runs = collectTextRuns($, $el, {});
      const alignment = getBlockAlignment($el);
      const options: any = {};

      if (alignment) options.alignment = alignment;

      if (tag.startsWith("h")) {
        const level = parseInt(tag.charAt(1));
        options.heading = (HeadingLevel as any)[`HEADING_${level}`];
      }

      if (runs.length > 0) {
        options.children = runs;
      } else {
        const img = $el.find("img");
        if (img.length > 0) {
          options.children = [new TextRun({ text: "[Imagen]", italics: true, color: "808080" })];
        } else if ($el.html()?.trim()) {
          options.children = [new TextRun({ text: $el.text().trim() })];
        } else {
          return;
        }
      }

      blocks.push(new Paragraph(options));
      return;
    }

    const runs = collectTextRuns($, $el, {});
    if (runs.length > 0) {
      blocks.push(new Paragraph({ children: runs }));
    }
  });

  return blocks;
}

export async function customHtmlToDocx(html: string): Promise<Buffer> {
  const $ = cheerioModule.load(html || "<p></p>", { decodeEntities: false });

  // Convert deprecated <font> tags to CSS spans for consistent processing
  const SIZE_MAP: Record<string, string> = {
    '1': '8pt', '2': '10pt', '3': '12pt', '4': '14pt',
    '5': '18pt', '6': '24pt', '7': '36pt'
  };
  $("font").each((_: number, el: any) => {
    const $el = $(el);
    const styles: string[] = [];
    const face = $el.attr("face");
    const size = $el.attr("size");
    const color = $el.attr("color");
    const existing = $el.attr("style") || "";
    if (existing) styles.push(existing);
    if (face) styles.push(`font-family: ${face}`);
    if (size && SIZE_MAP[size]) styles.push(`font-size: ${SIZE_MAP[size]}`);
    if (color) styles.push(`color: ${color}`);
    $el.replaceWith(`<span style="${styles.join('; ')}">${$el.html()}</span>`);
  });

  // Convert <s>/<strike>/<del> to spans with text-decoration for consistent processing
  $("s, strike, del").each((_: number, el: any) => {
    const $el = $(el);
    const existing = $el.attr("style") || "";
    const newStyle = existing ? `${existing}; text-decoration: line-through` : "text-decoration: line-through";
    $el.replaceWith(`<span style="${newStyle}">${$el.html()}</span>`);
  });

  const body = $("body").length ? $("body") : $.root();
  const blocks = htmlToDocxBlocks($, body);

  if (blocks.length === 0) {
    blocks.push(new Paragraph({ children: [new TextRun("")] }));
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "html-ordered",
          levels: [
            { level: 0, format: "decimal", text: "%1.", alignment: "left", style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: "lowerLetter", text: "%2)", alignment: "left", style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
          ],
        },
        {
          reference: "html-bullet",
          levels: [
            { level: 0, format: "bullet", text: "\u2022", alignment: "left", style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          ],
        },
      ],
    },
    sections: [{
      children: blocks,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
