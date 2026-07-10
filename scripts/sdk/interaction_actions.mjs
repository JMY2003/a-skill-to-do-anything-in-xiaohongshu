function compact(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function locatorText(locator) {
  return await locator.evaluate((el) => ("value" in el ? el.value : el.innerText || el.textContent || ""));
}

async function fillLocator(page, locator, text) {
  await locator.click();
  try {
    await locator.fill(text);
  } catch (fillError) {
    try {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.insertText(text);
    } catch (keyboardError) {
      throw new Error(`fill failed (${fillError.message}); keyboard fallback failed (${keyboardError.message})`);
    }
  }
  const expected = compact(text);
  const actual = compact(await locatorText(locator));
  if (expected && !actual.includes(expected)) {
    throw new Error(`field value could not be verified after fill (expected '${expected.slice(0, 80)}', got '${actual.slice(0, 80)}')`);
  }
}

export async function fillFirstVisible(page, selectors, text, label) {
  const errors = [];
  for (const sel of selectors) {
    const candidates = page.locator(sel);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      try {
        await fillLocator(page, locator, String(text));
        return sel;
      } catch (err) {
        errors.push(`${sel}[${index}]: ${err.message}`);
      }
    }
  }
  const suffix = errors.length ? ` (${errors.slice(0, 3).join("; ")})` : "";
  throw new Error(`No writable visible ${label} field found${suffix}`);
}

export async function fillFirstEditable(page, text) {
  return await fillFirstVisible(
    page,
    ["textarea", "[contenteditable='true']", "[role='textbox']", "input[type='text']"],
    text,
    "editable"
  );
}

async function clickTextCandidates(page, text, exact, waitMs) {
  const candidates = page.getByText(text, { exact });
  const count = await candidates.count().catch(() => 0);
  const errors = [];
  for (let index = count - 1; index >= 0; index--) {
    const locator = candidates.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    try {
      await locator.click();
      await page.waitForTimeout(waitMs);
      return { clicked: true, text, exact, index };
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { clicked: false, text, exact, errors };
}

export async function clickAnyText(page, texts, waitMs = 700) {
  for (const text of texts) {
    if (!text) continue;
    const result = await clickTextCandidates(page, text, true, waitMs);
    if (result.clicked) return result;
  }
  for (const text of texts) {
    if (!text) continue;
    const result = await clickTextCandidates(page, text, false, waitMs);
    if (result.clicked) return result;
  }
  return { clicked: false, texts };
}

export async function clickSemanticControl(page, kind, patterns = {}) {
  const pattern = patterns[kind] || new RegExp(kind, "i");
  const result = await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
    const disabled = (el) => Boolean(el.disabled) || el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true";
    const snapshot = (el) => ({
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600),
      aria: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      classes: String(el.className || "").slice(0, 600),
      pressed: el.getAttribute("aria-pressed") || "",
      checked: el.getAttribute("aria-checked") || "",
    });
    const controls = [...document.querySelectorAll("button,[role='button'],[aria-label],[title],svg,span,div")]
      .filter(visible)
      .map((el) => {
        const target = el.closest("button,[role='button'],a,[aria-label],[title]") || el;
        const state = snapshot(target);
        const { text, aria, title, classes } = state;
        return { el: target, disabled: disabled(target), haystack: `${text} ${aria} ${title} ${classes}`.slice(0, 600), text, aria, title };
      })
      .filter((item) => pattern.test(item.haystack));
    const selected = controls.find((item) => !item.disabled && /button|role|aria|title|icon|like|comment|collect|favorite|share|follow/i.test(item.haystack)) || controls.find((item) => !item.disabled);
    if (!selected) return { clicked: false, reason: controls.length ? "only disabled matching controls found" : "no semantic control found" };
    const token = `codex-semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.__codexSemanticTargets ||= new Map();
    window.__codexSemanticTargets.set(token, selected.el);
    const before = snapshot(selected.el);
    selected.el.click();
    return { clicked: true, text: selected.text, aria: selected.aria, title: selected.title, token, before };
  }, pattern.source);
  if (!result.clicked) throw new Error(`No enabled ${kind} control found: ${result.reason || ""}`);
  return result;
}

export async function verifySemanticClick(page, clickResult, waitMs = 0) {
  if (!clickResult?.token) {
    return { status: "unconfirmed", reason: "semantic control did not expose a verification target" };
  }
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  return await page.evaluate(({ token, before }) => {
    const snapshot = (el) => ({
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600),
      aria: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      classes: String(el.className || "").slice(0, 600),
      pressed: el.getAttribute("aria-pressed") || "",
      checked: el.getAttribute("aria-checked") || "",
    });
    const targets = window.__codexSemanticTargets;
    const target = targets?.get(token);
    targets?.delete(token);
    if (!(target instanceof HTMLElement) || !target.isConnected) {
      return { status: "unconfirmed", reason: "semantic control disappeared before its state could be checked", before };
    }
    const after = snapshot(target);
    const changedFields = Object.keys(before).filter((key) => before[key] !== after[key]);
    return changedFields.length
      ? { status: "confirmed", before, after, changedFields }
      : { status: "unconfirmed", reason: "semantic control state did not change after click", before, after };
  }, { token: clickResult.token, before: clickResult.before });
}

export async function verifyTextSubmission(page, selectors, text) {
  const expected = compact(text);
  if (!expected) {
    return { status: "unconfirmed", reason: "empty text has no reliable submission evidence" };
  }
  return await page.evaluate(({ selectors, expected }) => {
    const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
    const values = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter(visible)
      .map((el) => compact("value" in el ? el.value : el.innerText || el.textContent || ""));
    const stillInComposer = values.some((value) => value.includes(expected));
    return stillInComposer
      ? { status: "unconfirmed", reason: "submitted text is still present in an editable field", remainingFieldCount: values.filter((value) => value.includes(expected)).length }
      : { status: "confirmed", evidence: "submitted text cleared from editable fields" };
  }, { selectors, expected });
}
