export interface TextWalkNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<TextWalkNode>;
}

export interface TextNodeSpan<N> {
  node: N;
  start: number;
  length: number;
}

export interface DomText<N> {
  text: string;
  nodes: TextNodeSpan<N>[];
}

const BLOCKS = new Set([
  "P", "DIV", "LI", "UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE",
]);

const ELEMENT = 1;
const TEXT = 3;

export function collectDomText<N extends TextWalkNode>(
  root: N,
  onBlock?: (element: N, offset: number) => void,
): DomText<N> {
  let text = "";
  const nodes: TextNodeSpan<N>[] = [];
  const lineBreak = () => {
    if (text.length && !text.endsWith("\n")) text += "\n";
  };

  const walk = (node: N) => {
    if (node.nodeType === TEXT) {
      const value = node.nodeValue ?? "";
      if (value.length) {
        nodes.push({ node, start: text.length, length: value.length });
        text += value;
      }
      return;
    }
    if (node.nodeType !== ELEMENT) return;

    const name = node.nodeName.toUpperCase();
    if (name === "BR") {
      text += "\n";
      return;
    }
    const block = BLOCKS.has(name);
    if (block) {
      lineBreak();
      onBlock?.(node, text.length);
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) walk(children[i] as N);
    if (block) lineBreak();
  };

  walk(root);
  return { text, nodes };
}

/** The text node and offset inside it for a position in the collected text. */
export function locateOffset<N>(nodes: TextNodeSpan<N>[], offset: number, bias: "start" | "end"): { node: N; offset: number } | null {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = nodes[mid];
    const end = span.start + span.length;
    // A range end that falls exactly on a node boundary belongs to the node before it.
    const inside = bias === "start" ? offset >= span.start && offset < end : offset > span.start && offset <= end;
    if (inside) return { node: span.node, offset: offset - span.start };
    if (offset < span.start || (bias === "end" && offset === span.start)) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}
