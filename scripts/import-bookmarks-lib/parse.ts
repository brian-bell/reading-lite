import { parseHTML } from "linkedom";

export interface Link {
  url: string;
  title: string;
}

export interface Folder {
  name: string;
  folders: Folder[];
  links: Link[];
}

// Minimal DOM-shaped surface we need from linkedom, locally declared so the
// script compiles without pulling in the DOM lib (the project targets the
// Workers types which omit the full Element interface).
interface DomNode {
  tagName: string;
  textContent: string | null;
  children: ArrayLike<DomNode>;
  attributes: ArrayLike<{ name: string; value: string }>;
}

// Parses a Netscape-format bookmark file (Chrome's "Export Bookmarks" output).
// The format is loose enough that the HTML parser produces a tree that doesn't
// match the source's logical structure: every <DL> opens with a stray <p> that
// linkedom keeps as a wrapper around the DTs, and a folder's <DT><H3>...</H3>
// never closes, so the next "sibling" DT ends up nested inside via <p><dt>.
// We unfold both quirks when collecting a DL's logical DT children.
export function parseBookmarksHtml(raw: string): Folder {
  const { document } = parseHTML(raw);
  const rootDl = document.querySelector("dl") as DomNode | null;
  if (!rootDl) {
    return { name: "", folders: [], links: [] };
  }
  const { folders, links } = parseDl(rootDl);
  return { name: "", folders, links };
}

interface ParsedDl {
  folders: Folder[];
  links: Link[];
}

function parseDl(dl: DomNode): ParsedDl {
  const folders: Folder[] = [];
  const links: Link[] = [];
  for (const dt of logicalDtChildren(dl)) {
    const h3 = directChild(dt, "H3");
    const a = directChild(dt, "A");

    if (h3) {
      const subDl = directChild(dt, "DL");
      const sub: ParsedDl = subDl ? parseDl(subDl) : { folders: [], links: [] };
      folders.push({ name: h3.textContent ?? "", folders: sub.folders, links: sub.links });
    } else if (a) {
      const href = getAttrCI(a, "href");
      if (href) links.push({ url: href, title: a.textContent ?? "" });
    }
  }
  return { folders, links };
}

// Yields the DTs that are logically children of `dl` in source order, even
// though linkedom may have nested them under a wrapper <P> or chained them
// inside a previous folder DT's trailing <P>.
function logicalDtChildren(dl: DomNode): DomNode[] {
  const out: DomNode[] = [];
  walk(dl, out);
  return out;
}

function walk(parent: DomNode, out: DomNode[]): void {
  for (const child of nodeChildren(parent)) {
    const tag = child.tagName.toUpperCase();
    if (tag === "DT") {
      out.push(child);
      for (const grand of nodeChildren(child)) {
        if (grand.tagName.toUpperCase() === "P") walk(grand, out);
      }
    } else if (tag === "P") {
      walk(child, out);
    }
  }
}

function directChild(parent: DomNode, tag: string): DomNode | null {
  const upper = tag.toUpperCase();
  for (const child of nodeChildren(parent)) {
    if (child.tagName.toUpperCase() === upper) return child;
  }
  return null;
}

// Netscape bookmark exports use uppercase attribute names (HREF, ADD_DATE),
// and linkedom preserves the original case rather than normalizing — so a
// plain getAttribute("href") returns null. Look it up case-insensitively.
function getAttrCI(el: DomNode, name: string): string | null {
  const lower = name.toLowerCase();
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]!;
    if (attr.name.toLowerCase() === lower) return attr.value;
  }
  return null;
}

function nodeChildren(node: DomNode): DomNode[] {
  const out: DomNode[] = [];
  for (let i = 0; i < node.children.length; i++) {
    out.push(node.children[i]!);
  }
  return out;
}
