type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/** Tiny element builder: `on*` keys become listeners, booleans toggle attributes, text is never parsed as HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    // CSSOM, not the attribute: the page's CSP blocks inline style attributes.
    else if (k === "style") el.style.cssText = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

/** Scrolls `row` into view inside its scroll container (which must be positioned) without moving the page. */
export function scrollWithin(container: HTMLElement, row: HTMLElement) {
  const top = row.offsetParent === container ? row.offsetTop : row.offsetTop - container.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < container.scrollTop) container.scrollTop = Math.max(0, top - 8);
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 8;
}

/** Text clipped to `max` chars with a toggle that shows all of it; the toggle does not trigger the row's own click. */
export function longText(text: string, max = 80, shortForm?: string): HTMLElement {
  if (text.length <= max && (shortForm === undefined || shortForm === text)) return h("span", { class: "long" }, text);
  const base = shortForm ?? text;
  const short = base.length > max ? `${base.slice(0, max - 1)}…` : base;
  const value = h("span", { class: "long-value", title: text }, short);
  const toggle = h("button", { type: "button", class: "small long-toggle", "aria-expanded": "false" }, "more");
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "less" : "more";
    value.textContent = open ? text : short;
  });
  return h("span", { class: "long" }, value, " ", toggle);
}
