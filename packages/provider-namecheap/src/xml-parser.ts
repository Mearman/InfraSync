/**
 * Minimal XML parser for Namecheap API responses.
 *
 * Only handles the specific XML shapes Namecheap returns. Not a general-purpose
 * XML parser — no CDATA, namespaces, or mixed content support needed.
 *
 * Namecheap responses follow this shape:
 * <ApiResponse Status="OK|ERROR">
 *   <Errors />
 *   <CommandResponse Type="namecheap.domains.dns.getHosts">
 *     <DomainDNSGetHostsResult Domain="example.com">
 *       <host HostId="123" Name="www" Type="A" Address="1.2.3.4" MXPref="10" TTL="300" />
 *     </DomainDNSGetHostsResult>
 *   </CommandResponse>
 * </ApiResponse>
 */

export interface XmlElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  readonly text: string;
}

const EMPTY_ATTRIBUTES: Readonly<Record<string, string>> = {};

/**
 * Parse a Namecheap XML response string into an XmlElement tree.
 */
export function parseXml(xml: string): XmlElement {
  const stripped = xml.replace(/<\?xml[^?]*\?>/g, "").trim();
  return parseElement(stripped);
}

/**
 * Get an attribute value, returning a fallback if missing.
 */
export function getAttr(el: XmlElement, name: string, fallback = ""): string {
  const value = el.attributes[name];
  if (value !== undefined) return value;
  return fallback;
}

/**
 * Extract child elements matching a path of tag names.
 */
export function extractChildren(
  root: XmlElement,
  ...tagPath: string[]
): readonly XmlElement[] {
  let current: XmlElement = root;
  for (let i = 0; i < tagPath.length - 1; i++) {
    const next = current.children.find((c) => c.tag === tagPath[i]);
    if (next === undefined) return [];
    current = next;
  }
  const targetTag = tagPath[tagPath.length - 1];
  return current.children.filter((c) => c.tag === targetTag);
}

/**
 * Check if the ApiResponse indicates success.
 */
export function isApiSuccess(root: XmlElement): boolean {
  return getAttr(root, "Status") === "OK";
}

/**
 * Extract error messages from the ApiResponse Errors element.
 */
export function extractErrors(root: XmlElement): readonly string[] {
  const errors = root.children.find((c) => c.tag === "Errors");
  if (errors === undefined) return [];
  return errors.children.map(
    (c) => c.text || getAttr(c, "Number") || "Unknown error",
  );
}

// ─── Internal parser ─────────────────────────────────────────────────────────

function parseElement(xml: string): XmlElement {
  const openMatch = /^<(\w+)([^>]*?)(\/?)>/.exec(xml);
  if (openMatch === null) {
    return {
      tag: "unknown",
      attributes: EMPTY_ATTRIBUTES,
      children: [],
      text: xml,
    };
  }

  // exec() returns null or an array where indices 0-3 are defined when matched
  const tag = openMatch[0 + 1];
  const attrString = openMatch[1 + 1];
  const selfClosingSlash = openMatch[2 + 1];

  if (tag === undefined || attrString === undefined) {
    return {
      tag: "unknown",
      attributes: EMPTY_ATTRIBUTES,
      children: [],
      text: xml,
    };
  }

  const selfClosing = selfClosingSlash === "/";
  const attributes = parseAttributes(attrString);

  if (selfClosing) {
    return { tag, attributes, children: [], text: "" };
  }

  const afterOpen = xml.indexOf(">") + 1;
  const closeIdx = findClosingTag(xml, tag, afterOpen);

  if (closeIdx === -1) {
    return { tag, attributes, children: [], text: "" };
  }

  const inner = xml.slice(afterOpen, closeIdx).trim();

  if (inner.startsWith("<")) {
    const children = parseChildren(inner);
    return { tag, attributes, children, text: "" };
  }

  return { tag, attributes, children: [], text: inner };
}

function parseChildren(inner: string): XmlElement[] {
  const children: XmlElement[] = [];
  let remaining = inner;

  while (remaining.length > 0 && remaining.startsWith("<")) {
    if (remaining.startsWith("<!--")) {
      const commentEnd = remaining.indexOf("-->");
      if (commentEnd === -1) break;
      remaining = remaining.slice(commentEnd + 3).trim();
      continue;
    }

    const childOpen = /^<(\w+)/.exec(remaining);
    if (childOpen === null) break;

    const childTag = childOpen[1];
    if (childTag === undefined) break;

    const childClose = findClosingTag(remaining, childTag, 0);
    if (childClose === -1) break;

    const childEnd = remaining.indexOf(">", childClose) + 1;
    if (childEnd === 0) break;

    const childXml = remaining.slice(0, childEnd);
    children.push(parseElement(childXml));
    remaining = remaining.slice(childEnd).trim();
  }

  return children;
}

function findClosingTag(xml: string, tag: string, searchFrom: number): number {
  const closeTag = `</${tag}>`;
  let depth = 0;
  let pos = searchFrom;

  while (pos < xml.length) {
    const openIdx = xml.indexOf(`<${tag}`, pos);
    const closeIdx = xml.indexOf(closeTag, pos);

    if (closeIdx === -1) return -1;

    if (openIdx !== -1 && openIdx < closeIdx) {
      const afterOpen = xml.indexOf(">", openIdx);
      if (afterOpen !== -1 && xml[afterOpen - 1] === "/") {
        pos = afterOpen + 1;
        continue;
      }
      depth++;
      pos = closeIdx + closeTag.length;
    } else {
      if (depth === 0) return closeIdx;
      depth--;
      pos = closeIdx + closeTag.length;
    }
  }

  return -1;
}

function parseAttributes(attrString: string): Readonly<Record<string, string>> {
  if (attrString.length === 0) return EMPTY_ATTRIBUTES;
  const result: Record<string, string> = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrString)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
