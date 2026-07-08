export function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

export async function pageSnapshot(page, limit = 50) {
  return await page.evaluate((limit) => {
    const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => el instanceof HTMLElement && el.offsetParent !== null;
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      text: clean(el.innerText || el.textContent || el.value || "").slice(0, 200),
      aria: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      placeholder: el.getAttribute("placeholder") || "",
      role: el.getAttribute("role") || "",
      type: el.getAttribute("type") || "",
      href: el.href || "",
      classes: String(el.className || "").slice(0, 160),
    });
    const links = [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .slice(0, limit)
      .map((a) => ({ text: clean(a.innerText || a.textContent).slice(0, 160), href: a.href }));
    const editables = [...document.querySelectorAll("textarea,input,[contenteditable='true'],[role='textbox']")]
      .filter(visible)
      .slice(0, limit)
      .map(describe);
    const controls = [...document.querySelectorAll("button,[role='button'],input,textarea,[contenteditable='true'],[aria-label]")]
      .filter(visible)
      .slice(0, limit)
      .map(describe)
      .filter((item) => item.text || item.aria || item.title || item.placeholder || item.role || item.type);
    const customElements = [...document.querySelectorAll("*")]
      .filter((el) => el.tagName.includes("-") && visible(el))
      .slice(0, limit)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText || el.textContent || "").slice(0, 200),
        attrs: [...el.attributes].slice(0, 12).map((attr) => [attr.name, attr.value.slice(0, 160)]),
      }));
    const scrollables = [...document.querySelectorAll("body,main,section,div")]
      .filter((el) => visible(el) && (el.scrollHeight - el.clientHeight > 80 || el.scrollWidth - el.clientWidth > 80))
      .slice(0, limit)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText || el.textContent || "").slice(0, 120),
        classes: String(el.className || "").slice(0, 160),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      }));
    return {
      url: location.href,
      title: document.title,
      body: clean(document.body?.innerText || "").slice(0, 3000),
      links,
      editables,
      controls,
      customElements,
      scrollables,
    };
  }, limit);
}

export async function detectBlock(page, blockRules) {
  const url = page.url();
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const excerpt = cleanText(text).slice(0, 600);
  for (const rule of blockRules) {
    const urlMatch = rule.url ? rule.url.test(url) : false;
    const textMatch = rule.text ? rule.text.test(excerpt) : false;
    if (urlMatch || textMatch) return { type: rule.type, url, excerpt };
  }
  return null;
}

export async function assertNotBlocked(page, blockRules, label = "operation") {
  const block = await detectBlock(page, blockRules);
  if (!block) return null;
  throw new Error(`${block.type} block during ${label}: ${block.excerpt || block.url}`);
}

export async function scrollAllContainers(page) {
  return await page.evaluate(() => {
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el === document.body);
    const items = [...document.querySelectorAll("body,main,section,div")]
      .filter((el) => visible(el) && el.scrollHeight - el.clientHeight > 40)
      .slice(0, 80)
      .map((el) => {
        const before = { top: el.scrollTop, left: el.scrollLeft };
        el.scrollTop = el.scrollHeight;
        el.scrollLeft = el.scrollWidth;
        return {
          tag: el.tagName.toLowerCase(),
          classes: String(el.className || "").slice(0, 120),
          before,
          after: { top: el.scrollTop, left: el.scrollLeft },
        };
      });
    return items;
  });
}
