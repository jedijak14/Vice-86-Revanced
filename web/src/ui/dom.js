// Small DOM helpers shared by the HUD and the menus.
//
// Everything takes the document explicitly: the UI is built for whichever document owns the root
// element, which also lets the tests run it against a stub document.
//
// The cached writers at the bottom are how the HUD keeps its promise of touching the DOM only when
// a displayed value changes: each remembers the last value it wrote and returns early on a repeat.

const SVG_NS = 'http://www.w3.org/2000/svg';

function appendAll(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? node.ownerDocument.createTextNode(child) : child);
  }
  return node;
}

/** Creates an HTML element with a class and children (nodes or strings; null and false are skipped). */
export function el(doc, tag, className, ...children) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return appendAll(node, children);
}

/** Creates an SVG element with attributes and children. */
export function svg(doc, tag, attributes, ...children) {
  const node = doc.createElementNS(SVG_NS, tag);
  if (attributes) for (const name in attributes) node.setAttribute(name, String(attributes[name]));
  return appendAll(node, children);
}

/** Sets several attributes at once and returns the node. */
export function attrs(node, attributes) {
  for (const name in attributes) node.setAttribute(name, String(attributes[name]));
  return node;
}

/** Writer for a node's text that skips repeats. */
export function textWriter(node) {
  let last;
  return (value) => {
    if (value === last) return;
    last = value;
    node.textContent = value;
  };
}

/** Writer that turns one class on or off and skips repeats. */
export function classWriter(node, name, initial = false) {
  let last = initial;
  return (on) => {
    if (on === last) return;
    last = on;
    node.classList.toggle(name, on);
  };
}

/** Writer for one inline style property (custom properties included) that skips repeats. */
export function styleWriter(node, property) {
  let last;
  return (value) => {
    if (value === last) return;
    last = value;
    node.style.setProperty(property, value);
  };
}

/** Writer for one attribute that skips repeats. */
export function attrWriter(node, name) {
  let last;
  return (value) => {
    if (value === last) return;
    last = value;
    node.setAttribute(name, value);
  };
}
