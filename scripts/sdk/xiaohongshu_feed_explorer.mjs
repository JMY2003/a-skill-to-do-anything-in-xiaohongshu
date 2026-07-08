export async function collectXiaohongshuFeedItems(page, { limit = 20 } = {}) {
  return await page.evaluate((limit) => {
    const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
    const visible = (el) => el instanceof HTMLElement && (el.offsetParent !== null || el.getClientRects().length > 0);
    const items = [];
    const seen = new Set();
    const stateKeys = Object.keys(window).filter((key) => /INITIAL|STATE|REDUX|STORE|APP/i.test(key)).slice(0, 40);

    const firstText = (...values) => {
      for (const value of values) {
        const text = clean(value);
        if (text) return text;
      }
      return "";
    };

    const pushItem = (item) => {
      const key = item.id || item.href || item.text?.slice(0, 160);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    try {
      const state = window.__INITIAL_STATE__;
      const rawFeeds = state?.search?.feeds?.value ?? state?.search?.feeds?._value ?? state?.feed?.feeds?.value ?? state?.feed?.feeds?._value;
      const feeds = typeof rawFeeds === "string" ? JSON.parse(rawFeeds) : rawFeeds;
      if (Array.isArray(feeds)) {
        for (const feed of feeds) {
          const note = feed?.note_card || feed?.noteCard || feed?.note || feed;
          const id = note?.id || note?.noteId || note?.note_id || feed?.id || feed?.noteId || feed?.note_id;
          const xsecToken = feed?.xsec_token || feed?.xsecToken || note?.xsec_token || "";
          const href = id ? `https://www.xiaohongshu.com/explore/${id}${xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed` : ""}` : "";
          pushItem({
            kind: "note",
            source: "initial-state",
            id,
            xsecToken,
            title: firstText(note?.displayTitle, note?.display_title, note?.title, note?.desc, note?.description),
            author: firstText(note?.user?.nickName, note?.user?.nickname, note?.user_info?.nickName, note?.user_info?.nickname),
            href,
            likeCount: firstText(note?.interactInfo?.likedCount, note?.interact_info?.liked_count),
            commentCount: firstText(note?.interactInfo?.commentCount, note?.interact_info?.comment_count),
            rawType: feed?.modelType || feed?.model_type || feed?.type || note?.type || "",
          });
          if (items.length >= limit) break;
        }
      }
    } catch (_) {
      // Fall back to visible DOM extraction below.
    }

    if (items.length < limit) {
      for (const a of [...document.querySelectorAll("a[href]")]) {
        const href = new URL(a.getAttribute("href"), location.href).href;
        const text = clean(a.innerText || a.textContent);
        if (!text || !/xiaohongshu\.com\/(explore|search_result|user\/profile)/.test(href)) continue;
        pushItem({ kind: "link", source: "dom-anchor", text, href });
        if (items.length >= limit) break;
      }
    }

    if (items.length < limit) {
      const blocks = [...document.querySelectorAll("section,article,li,div")]
        .filter(visible)
        .map((el) => {
          const text = clean(el.innerText || el.textContent);
          if (text.length < 18 || text.length > 600) return null;
          if (/登录|注册|隐私政策|用户协议|创作中心|业务合作/.test(text)) return null;
          const hrefs = [...el.querySelectorAll("a[href]")]
            .map((a) => new URL(a.getAttribute("href"), location.href).href)
            .filter((href) => /xiaohongshu\.com/i.test(href));
          return { kind: "text-card", source: "dom-virtual-card", text: text.slice(0, 500), href: hrefs[0] || "", hrefs: hrefs.slice(0, 6) };
        })
        .filter(Boolean);
      for (const block of blocks) {
        pushItem(block);
        if (items.length >= limit) break;
      }
    }

    return {
      url: location.href,
      title: document.title,
      stateKeys,
      items: items.slice(0, limit),
      sourceSummary: {
        initialState: items.filter((item) => item.source === "initial-state").length,
        domAnchors: items.filter((item) => item.source === "dom-anchor").length,
        domVirtualCards: items.filter((item) => item.source === "dom-virtual-card").length,
      },
    };
  }, Number(limit));
}
