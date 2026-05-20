import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

interface XmlDocument {
  documentElement: XmlElement | null;
  getElementsByTagName(tagName: string): XmlElement[];
  getElementsByTagNameNS(namespace: string | null, tagName: string): XmlElement[];
}

interface XmlElement {
  nodeName: string;
  textContent: string;
  parentNode: XmlElement | null;
  nextSibling: XmlElement | null;
  firstChild: XmlElement | null;
  childNodes: XmlElement[];
  attributes?: { name: string; value: string }[];
  ownerDocument?: XmlDocument | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  lookupPrefix(namespace: string): string | null;
  lookupNamespaceURI(prefix: string | null): string | null;
  getElementsByTagName(tagName: string): XmlElement[];
  insertBefore(newNode: XmlElement, refNode: XmlElement | null): XmlElement;
  removeChild(node: XmlElement): XmlElement;
  appendChild(node: XmlElement): XmlElement;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

interface ZipFileOutput {
  type: string;
  compression: string;
  compressionOptions: { level: number };
}

export class DocxEngine {
  private zip: PizZip;
  private domParser: DOMParser;
  private xmlSerializer: XMLSerializer;

  constructor(buffer: Buffer | Uint8Array) {
    this.zip = new PizZip(buffer);
    this.domParser = new DOMParser();
    this.xmlSerializer = new XMLSerializer();
  }

  private getXmlDoc(filePath: string): XmlDocument {
    const file = this.zip.file(filePath);
    if (!file) {
      throw new Error(`File ${filePath} not found in the DOCX archive.`);
    }
    const xmlText = file.asText();
    return this.domParser.parseFromString(xmlText, 'text/xml') as unknown as XmlDocument;
  }

  private saveXmlDoc(filePath: string, doc: XmlDocument): void {
    const xmlText = this.xmlSerializer.serializeToString(doc as AnyNode);
    this.zip.file(filePath, xmlText);
  }

  public extractText(): string {
    const doc = this.getXmlDoc('word/document.xml');
    const textNodes = doc.getElementsByTagName('w:t');
    let extracted = '';
    for (let i = 0; i < textNodes.length; i++) {
      const textContent = textNodes[i].textContent;
      if (textContent) {
        extracted += textContent;
      }
      const parent = textNodes[i].parentNode;
      if (parent && parent.nextSibling && parent.nextSibling.nodeName === 'w:p') {
        extracted += '\n';
      }
    }
    return extracted;
  }

  public getComponentXml(component: string): string {
    const filePath = `word/${component}.xml`;
    const file = this.zip.file(filePath);
    if (!file) {
      throw new Error(`Component ${filePath} not found in the DOCX archive.`);
    }
    return file.asText();
  }

  /**
   * Finds a DOM node whose serialized XML matches the targetXml string,
   * then replaces it with the parsed replacementXml using proper DOM manipulation.
   * Falls back to string replacement if the DOM approach fails.
   */
  public replaceInComponent(component: string, targetXml: string, replacementXml: string): boolean {
    const filePath = `word/${component}.xml`;
    const file = this.zip.file(filePath);
    if (!file) {
      throw new Error(`Component ${filePath} not found in the DOCX archive.`);
    }

    const doc = this.getXmlDoc(filePath);

    const targetDoc = this.domParser.parseFromString(
      `<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${targetXml}</root>`,
      'text/xml'
    ) as unknown as XmlDocument;

    const targetRoot = targetDoc.documentElement;
    if (!targetRoot || !targetRoot.childNodes || targetRoot.childNodes.length === 0) {
      return false;
    }

    const targetNode = targetRoot.childNodes[0];
    const tagName = targetNode.nodeName;

    if (!tagName) {
      return false;
    }

    const candidates = doc.getElementsByTagName(tagName);

    const targetSerialized = this.xmlSerializer.serializeToString(targetNode as AnyNode).trim();
    const replacementDoc = this.domParser.parseFromString(
      `<root>${replacementXml}</root>`,
      'text/xml'
    ) as unknown as XmlDocument;
    const replacementRoot = replacementDoc.documentElement;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i] as AnyNode;
      const candidateSerialized = this.xmlSerializer.serializeToString(candidate).trim();

      if (candidateSerialized === targetSerialized) {
        const parent = candidate.parentNode as unknown as XmlElement | null;
        if (parent && replacementRoot) {
          const importNode = (fn: (node: Element) => Element) => {
            return fn(candidate as unknown as Element);
          };

          try {
            while (replacementRoot.childNodes && replacementRoot.childNodes.length > 0) {
              const child = replacementRoot.childNodes[0] as unknown as Element;
              if (child && typeof candidate.parentNode !== 'undefined') {
                (candidate.parentNode as Element).insertBefore(child, candidate as unknown as Element);
              }
            }
            if (candidate.parentNode) {
              (candidate as unknown as ChildNode).parentNode!.removeChild(candidate as unknown as ChildNode);
            }
          } catch {
            while (replacementRoot.childNodes && replacementRoot.childNodes.length > 0) {
              const child = replacementRoot.childNodes[0] as unknown as Node;
              if (candidate.parentNode) {
                candidate.parentNode.insertBefore(child, candidate);
              }
            }
            if (candidate.parentNode) {
              candidate.parentNode.removeChild(candidate);
            }
          }

          this.saveXmlDoc(filePath, doc);
          return true;
        }
      }
    }

    const content = file.asText();
    if (content.includes(targetXml)) {
      const newContent = content.replace(targetXml, replacementXml);
      this.zip.file(filePath, newContent);
      return true;
    }

    return false;
  }

  /**
   * Finds all <w:t> elements whose text content matches the search text
   * and replaces their text. No XML knowledge required from the caller.
   */
  public findAndReplaceText(searchText: string, replaceText: string): number {
    const doc = this.getXmlDoc('word/document.xml');
    const textNodes = doc.getElementsByTagName('w:t');
    let replaced = 0;

    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      if (node.textContent && node.textContent.includes(searchText)) {
        node.textContent = node.textContent.replace(searchText, replaceText);
        replaced++;
      }
    }

    if (replaced > 0) {
      this.saveXmlDoc('word/document.xml', doc);
    }

    return replaced;
  }

  /**
   * Updates document formatting settings in word/settings.xml.
   * Supported options: margins (top/right/bottom/left in twips), pageSize (width/height in twips).
   * 1 inch = 1440 twips. 1 cm = 567 twips. A4 = 11906x16838 twips.
   */
  public updateFormatting(settings: {
    margins?: { top?: number; right?: number; bottom?: number; left?: number };
    pageSize?: { width?: number; height?: number };
  }): boolean {
    try {
      const doc = this.getXmlDoc('word/settings.xml');
      let modified = false;

      if (settings.margins) {
        const sectPrNodes = doc.getElementsByTagName('w:sectPr');
        for (let i = 0; i < sectPrNodes.length; i++) {
          const pgMarNodes = sectPrNodes[i].getElementsByTagName('w:pgMar');
          if (pgMarNodes.length > 0) {
            const pgMar = pgMarNodes[0];
            const m = settings.margins;
            if (m.top !== undefined) { pgMar.setAttribute('w:top', String(m.top)); modified = true; }
            if (m.right !== undefined) { pgMar.setAttribute('w:right', String(m.right)); modified = true; }
            if (m.bottom !== undefined) { pgMar.setAttribute('w:bottom', String(m.bottom)); modified = true; }
            if (m.left !== undefined) { pgMar.setAttribute('w:left', String(m.left)); modified = true; }
          } else {
            const pgMar = sectPrNodes[i].ownerDocument
              ? (sectPrNodes[i] as unknown as Node).ownerDocument!.createElement('w:pgMar')
              : null;
            if (pgMar) {
              const m = settings.margins;
              if (m.top !== undefined) pgMar.setAttribute('w:top', String(m.top));
              if (m.right !== undefined) pgMar.setAttribute('w:right', String(m.right));
              if (m.bottom !== undefined) pgMar.setAttribute('w:bottom', String(m.bottom));
              if (m.left !== undefined) pgMar.setAttribute('w:left', String(m.left));
              (sectPrNodes[i] as unknown as Node).insertBefore(pgMar, (sectPrNodes[i] as unknown as Node).firstChild);
              modified = true;
            }
          }
        }
      }

      if (settings.pageSize) {
        const sectPrNodes = doc.getElementsByTagName('w:sectPr');
        for (let i = 0; i < sectPrNodes.length; i++) {
          const pgSzNodes = sectPrNodes[i].getElementsByTagName('w:pgSz');
          if (pgSzNodes.length > 0) {
            const pgSz = pgSzNodes[0];
            if (settings.pageSize.width !== undefined) { pgSz.setAttribute('w:w', String(settings.pageSize.width)); modified = true; }
            if (settings.pageSize.height !== undefined) { pgSz.setAttribute('w:h', String(settings.pageSize.height)); modified = true; }
          }
        }
      }

      if (modified) {
        this.saveXmlDoc('word/settings.xml', doc);
      }

      return modified;
    } catch {
      return false;
    }
  }

  /**
   * Returns the structured text content with paragraph breaks.
   */
  public getStructuredText(): string {
    const doc = this.getXmlDoc('word/document.xml');
    const paragraphs = doc.getElementsByTagName('w:p');
    const lines: string[] = [];

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      const textNodes = p.getElementsByTagName('w:t');
      const texts: string[] = [];
      for (let j = 0; j < textNodes.length; j++) {
        if (textNodes[j].textContent) {
          texts.push(textNodes[j].textContent);
        }
      }
      const line = texts.join('');
      if (line.trim()) {
        lines.push(`[P${i + 1}] ${line}`);
      }
    }

    return lines.join('\n');
  }

  public generateBuffer(): Buffer {
    const outOptions: ZipFileOutput = {
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6
      }
    };
    return this.zip.generate(outOptions as unknown as Record<string, unknown>) as unknown as Buffer;
  }
}
