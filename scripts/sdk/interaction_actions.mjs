export async function fillFirstVisible(page, selectors, text, label) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => true))) continue;
    await loc.click();
    await loc.fill(text).catch(async () => {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await page.keyboard.insertText(text);
    });
    return sel;
  }
  throw new Error(`No visible ${label} field found`);
}

export async function fillFirstEditable(page, text) {
  return await fillFirstVisible(
    page,
    ["textarea", "input[type='text']", "[contenteditable='true']", "[role='textbox']"],
    text,
    "editable"
  );
}

export async function clickAnyText(page, texts, waitMs = 700) {
  for (const text of texts) {
    const loc = page.getByText(text, { exact: true }).last();
    if (await loc.count().catch(() => 0)) {
      await loc.click().catch(() => {});
      await page.waitForTimeout(waitMs);
      return { clicked: true, text, exact: true };
    }
  }
  for (const text of texts) {
    const loc = page.getByText(text).last();
    if (await loc.count().catch(() => 0)) {
      await loc.click().catch(() => {});
      await page.waitForTimeout(waitMs);
      return { clicked: true, text, exact: false };
    }
  }
  return { clicked: false, texts };
}

export async function clickSemanticControl(page, kind, patterns = {}) {
  const pattern = patterns[kind] || new RegExp(kind, "i");
  const result = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
    const controls = [...document.querySelectorAll("button,[role='button'],[aria-label],[title],svg,span,div")]
      .filter(visible)
      .map((el) => {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const aria = el.getAttribute("aria-label") || "";
        const title = el.getAttribute("title") || "";
        const classes = String(el.className || "");
        return { el, haystack: `${text} ${aria} ${title} ${classes}`.slice(0, 600), text, aria, title };
      })
      .filter((item) => pattern.test(item.haystack));
    const selected = controls.find((item) => /button|role|aria|title|icon|like|comment|collect|favorite|share|follow/i.test(item.haystack)) || controls[0];
    if (!selected) return { clicked: false, reason: "no semantic control found" };
    selected.el.click();
    return { clicked: true, text: selected.text, aria: selected.aria, title: selected.title };
  }, pattern.source);
  if (!result.clicked) throw new Error(`No ${kind} control found: ${result.reason || ""}`);
  return result;
}
