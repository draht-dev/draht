(() => {
  "use strict";

  const UI_LANGUAGE = getUiLanguage();
  const STATE = {
    toastTimer: null
  };
  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "CAPTION",
    "DIV",
    "DL",
    "DT",
    "DD",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "THEAD",
    "TFOOT",
    "TR",
    "TD",
    "TH",
    "UL"
  ]);
  const INLINE_IGNORED_TAGS = new Set([
    "BUTTON",
    "FORM",
    "INPUT",
    "LABEL",
    "NOSCRIPT",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "TEMPLATE",
    "TEXTAREA"
  ]);

  function t(messageName, substitutions, fallback = "") {
    const message =
      typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function"
        ? chrome.i18n.getMessage(messageName, substitutions)
        : "";

    return message || fallback || messageName;
  }

  function getUiLanguage() {
    if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
      return chrome.i18n.getUILanguage();
    }

    return navigator.language || "zh-CN";
  }

  function showToast(message) {
    let toast = document.querySelector("[data-x2markdown-toast='true']");
    if (!(toast instanceof HTMLElement)) {
      toast = document.createElement("div");
      toast.dataset.x2markdownToast = "true";
      toast.className = "x2markdown-toast";
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add("x2markdown-toast--visible");

    if (STATE.toastTimer) {
      window.clearTimeout(STATE.toastTimer);
    }

    STATE.toastTimer = window.setTimeout(() => {
      toast.classList.remove("x2markdown-toast--visible");
    }, 2200);
  }

  async function copyToClipboard(text) {
    if (copyWithExecCommand(text)) {
      return;
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        // Some pages reject Clipboard API calls in content scripts even when fallback copy works.
      }
    }

    throw new Error(t("errorClipboardRetry", undefined, "Copy failed, please try again manually"));
  }

  function copyWithExecCommand(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.top = "0";
    textarea.style.left = "0";

    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      return document.execCommand("copy");
    } catch (error) {
      return false;
    } finally {
      textarea.remove();
    }
  }

  function extractSelectionPayload() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const selectedText = normalizeText(selection.toString());
    if (!selectedText) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchorNode =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;

    if (isEditableNode(anchorNode)) {
      throw new Error(
        t(
          "errorEditableSelectionNotSupported",
          undefined,
          "The current selection is inside an editable field. Please select page content instead."
        )
      );
    }

    const fragment = range.cloneContents();
    const converted = convertNodeToMarkdown(fragment);
    const bodyMarkdown = converted.markdown || normalizeMarkdownBlock(selection.toString());

    if (!bodyMarkdown) {
      return null;
    }

    return {
      sourceKind: "selection",
      title: normalizeText(document.title),
      url: cleanPageUrl(location.href),
      author: "",
      publishedAt: "",
      siteName: getDisplaySiteName(),
      bodyMarkdown,
      images: converted.images
    };
  }

  function convertNodeToMarkdown(root) {
    const context = {
      images: [],
      imageSet: new Set()
    };
    const markdown = normalizeMarkdownBlock(renderBlocks(root, context, 0));

    return {
      markdown,
      images: context.images
    };
  }

  function renderBlocks(root, context, listDepth) {
    const blocks = [];
    const inlineBuffer = [];

    function flushInlineBuffer() {
      if (inlineBuffer.length === 0) {
        return;
      }

      const text = normalizeMarkdownBlock(renderInlineNodes(inlineBuffer, context));
      inlineBuffer.length = 0;
      if (text) {
        blocks.push(text);
      }
    }

    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        inlineBuffer.push(child);
        continue;
      }

      if (!(child instanceof Element) || shouldIgnoreElement(child)) {
        continue;
      }

      if (isBlockElement(child)) {
        flushInlineBuffer();
        const rendered = renderBlockElement(child, context, listDepth);
        if (rendered) {
          blocks.push(rendered);
        }
        continue;
      }

      inlineBuffer.push(child);
    }

    flushInlineBuffer();

    return blocks.filter(Boolean).join("\n\n");
  }

  function renderBlockElement(element, context, listDepth) {
    const tagName = element.tagName;

    if (tagName === "HR") {
      return "---";
    }

    if (/^H[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      const text = normalizeMarkdownBlock(renderInlineNodes(Array.from(element.childNodes), context));
      return text ? `${"#".repeat(level)} ${text}` : "";
    }

    if (tagName === "PRE") {
      const code = preserveCodeText(element);
      return code ? `\`\`\`\n${code}\n\`\`\`` : "";
    }

    if (tagName === "BLOCKQUOTE") {
      const text = normalizeMarkdownBlock(renderBlocks(element, context, listDepth));
      return text
        ? text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
        : "";
    }

    if (tagName === "UL" || tagName === "OL") {
      return renderList(element, context, listDepth);
    }

    if (tagName === "TABLE") {
      return renderTable(element, context);
    }

    if (tagName === "FIGURE") {
      return normalizeMarkdownBlock(renderBlocks(element, context, listDepth));
    }

    if (tagName === "IMG") {
      registerImage(element, context);
      return "";
    }

    if (tagName === "P" || tagName === "FIGCAPTION" || tagName === "TD" || tagName === "TH") {
      return normalizeMarkdownBlock(renderInlineNodes(Array.from(element.childNodes), context));
    }

    const nested = renderBlocks(element, context, listDepth);
    if (nested) {
      return nested;
    }

    return normalizeMarkdownBlock(renderInlineNodes(Array.from(element.childNodes), context));
  }

  function renderList(element, context, listDepth) {
    const ordered = element.tagName === "OL";
    const items = Array.from(element.children).filter((child) => child instanceof HTMLLIElement);
    let itemIndex = 0;
    const renderedItems = items
      .map((item) => {
        const rendered = renderListItem(item, context, listDepth, ordered, itemIndex);
        if (rendered) {
          itemIndex += 1;
        }
        return rendered;
      })
      .filter(Boolean);

    return renderedItems.join("\n");
  }

  function renderListItem(item, context, listDepth, ordered, itemIndex) {
    const body = normalizeMarkdownBlock(renderBlocks(item, context, listDepth + 1));
    if (!body) {
      return "";
    }

    const indent = "  ".repeat(Math.max(listDepth, 0));
    const marker = ordered ? `${itemIndex + 1}.` : "-";
    const continuation = " ".repeat(marker.length + 1);
    const lines = body.split("\n");

    return lines
      .map((line, index) => {
        if (index === 0) {
          return `${indent}${marker} ${line}`;
        }

        return `${indent}${continuation}${line}`;
      })
      .join("\n");
  }

  function renderTable(table, context) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((row) => {
        return Array.from(row.children)
          .filter((cell) => cell instanceof HTMLTableCellElement)
          .map((cell) => normalizeMarkdownBlock(renderInlineNodes(Array.from(cell.childNodes), context)));
      })
      .filter((cells) => cells.length > 0);

    if (rows.length === 0) {
      return "";
    }

    const columnCount = Math.max(...rows.map((cells) => cells.length));
    const padded = rows.map((cells) => {
      while (cells.length < columnCount) {
        cells.push("");
      }
      return cells;
    });

    const separatorRow = `| ${padded[0].map(() => "---").join(" | ")} |`;
    const bodyRows = padded.slice(1).map((cells) => `| ${cells.join(" | ")} |`);

    return [`| ${padded[0].join(" | ")} |`, separatorRow].concat(bodyRows).join("\n");
  }

  // Walker inline rendering is used for Readability output and cloned selections.
  // At this stage DOM has already been narrowed to content, so we filter widgets by tag/attributes.
  function renderInlineNodes(nodes, context) {
    return normalizeInlineText(nodes.map((node) => renderInlineNode(node, context)).join(""));
  }

  function renderInlineNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (!(node instanceof Element) || shouldIgnoreElement(node)) {
      return "";
    }

    const tagName = node.tagName;

    if (tagName === "BR") {
      return "\n";
    }

    if (tagName === "IMG") {
      registerImage(node, context);
      const alt = normalizeText(node.getAttribute("alt"));
      return alt && alt.toLowerCase() !== "image" ? alt : "";
    }

    if (tagName === "A") {
      const href = toAbsoluteUrl(node.getAttribute("href"));
      const text = normalizeMarkdownBlock(renderInlineNodes(Array.from(node.childNodes), context));

      if (!href) {
        return text;
      }

      if (!text) {
        return href;
      }

      if (looksLikeAbsoluteUrl(text)) {
        return href;
      }

      return `[${escapeMarkdownText(text)}](${href})`;
    }

    if (tagName === "CODE" && node.parentElement?.tagName !== "PRE") {
      const text = normalizeInlineText(node.textContent || "");
      return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
    }

    if (tagName === "STRONG" || tagName === "B") {
      const text = normalizeMarkdownBlock(renderInlineNodes(Array.from(node.childNodes), context));
      return text ? `**${text}**` : "";
    }

    if (tagName === "EM" || tagName === "I") {
      const text = normalizeMarkdownBlock(renderInlineNodes(Array.from(node.childNodes), context));
      return text ? `*${text}*` : "";
    }

    if (tagName === "DEL" || tagName === "S" || tagName === "STRIKE") {
      const text = normalizeMarkdownBlock(renderInlineNodes(Array.from(node.childNodes), context));
      return text ? `~~${text}~~` : "";
    }

    return renderInlineNodes(Array.from(node.childNodes), context);
  }

  function registerImage(imageNode, context) {
    if (!(imageNode instanceof HTMLImageElement)) {
      return;
    }

    const source = normalizeMediaUrl(imageNode.currentSrc || imageNode.src || imageNode.getAttribute("src") || "");
    if (!source || context.imageSet.has(source)) {
      return;
    }

    context.imageSet.add(source);
    context.images.push(source);
  }

  function preserveCodeText(node) {
    const code = node.textContent || "";
    return code.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function isBlockElement(element) {
    return BLOCK_TAGS.has(element.tagName);
  }

  function shouldIgnoreElement(element) {
    if (!(element instanceof Element)) {
      return true;
    }

    if (element.hasAttribute("hidden")) {
      return true;
    }

    if (element.getAttribute("aria-hidden") === "true" && !String(element.className || "").includes("fallback-image")) {
      return true;
    }

    return INLINE_IGNORED_TAGS.has(element.tagName);
  }

  function isEditableNode(node) {
    const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    if (!(element instanceof Element)) {
      return false;
    }

    if (element.closest("textarea, input, select")) {
      return true;
    }

    const editable = element.closest("[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']");
    return editable instanceof Element;
  }

  function buildGenericMarkdown(payload) {
    const lines = [];
    const title = normalizeText(payload.title);
    const siteName = normalizeText(payload.siteName);
    const author = formatAuthor(payload.author);
    const time = normalizeText(payload.publishedAt);
    const url = cleanPageUrl(payload.url || location.href);
    const body = normalizeMarkdownBlock(payload.bodyMarkdown);
    const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];

    if (title) {
      lines.push(`# ${title}`, "");
    }

    if (siteName) {
      lines.push(t("markdownSiteLine", siteName, `Site: ${siteName}`));
    }

    if (author) {
      lines.push(t("markdownAuthorLine", author, `Author: ${author}`));
    }

    if (time) {
      lines.push(t("markdownTimeLine", time, `Time: ${time}`));
    }

    if (url) {
      lines.push(t("markdownLinkLine", url, `Link: ${url}`));
    }

    if (body) {
      lines.push("", t("markdownBodyLabel", undefined, "Body:"), body);
    }

    if (images.length > 0) {
      lines.push("", t("markdownImageSectionLabel", undefined, "Images:"));
      images.forEach((imageUrl, index) => {
        lines.push(`- [${t("markdownImageLabel", String(index + 1), `Image ${index + 1}`)}](${imageUrl})`);
      });
    }

    return lines.join("\n").trim();
  }

  function formatAuthor(author) {
    if (!author) {
      return "";
    }

    if (typeof author === "string") {
      return normalizeText(author);
    }

    if (author.displayName && author.handle) {
      return `${author.displayName} (${author.handle})`;
    }

    return author.displayName || author.handle || "";
  }

  function collectTextTokens(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest("[role='menu'], [role='button'], button")) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const tokens = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      const value = normalizeText(currentNode.textContent);
      if (value) {
        tokens.push(value);
      }

      currentNode = walker.nextNode();
    }

    return unique(tokens);
  }

  function firstVisibleElement(nodes) {
    for (const node of nodes) {
      if (node instanceof HTMLElement && isVisible(node)) {
        return node;
      }
    }

    return null;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(value) {
    return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeInlineText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  }

  function normalizeMarkdownBlock(value) {
    return normalizeInlineText(value).replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeMediaUrl(value) {
    try {
      return new URL(value, document.baseURI).href;
    } catch (error) {
      return "";
    }
  }

  function toAbsoluteUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, document.baseURI).href;
    } catch (error) {
      return "";
    }
  }

  function cleanPageUrl(value) {
    try {
      const url = new URL(value, document.baseURI);
      url.search = "";
      url.hash = "";
      return url.href;
    } catch (error) {
      return value;
    }
  }

  function escapeMarkdownText(value) {
    return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  }

  function formatTimeValue(dateTime, fallbackText = "") {
    if (dateTime) {
      const date = new Date(dateTime);
      if (!Number.isNaN(date.getTime())) {
        return new Intl.DateTimeFormat(UI_LANGUAGE, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        })
          .format(date)
          .replace(/\//g, "-");
      }
    }

    return fallbackText;
  }

  function getDisplaySiteName() {
    return location.hostname.replace(/^www\./, "");
  }

  function looksLikeAbsoluteUrl(value) {
    return /^https?:\/\//i.test(value);
  }

  function uniqueByKey(values, getKey) {
    const seen = new Set();
    return values.filter((value) => {
      const key = getKey(value);
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function extractInlineMarkdown(node) {
    if (!(node instanceof Node)) {
      return "";
    }

    const content =
      node.nodeType === Node.TEXT_NODE
        ? node.textContent || ""
        : renderLiveInlineChildren(node, createLiveInlineStyleState());

    return normalizeInlineText(content);
  }

  function renderLiveInlineChildren(node, parentStyleState) {
    if (!node || !node.childNodes) {
      return "";
    }

    return Array.from(node.childNodes)
      .map((child) => renderLiveInlineNode(child, parentStyleState))
      .join("");
  }

  function renderLiveInlineNode(node, parentStyleState) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (!(node instanceof Element) || !isVisible(node)) {
      return "";
    }

    if (node.tagName === "BR") {
      return "\n";
    }

    if (node.tagName === "IMG") {
      const alt = normalizeText(node.getAttribute("alt"));
      return alt && alt.toLowerCase() !== "image" ? alt : "";
    }

    const currentStyleState = getLiveInlineStyleState(node, parentStyleState);

    if (node instanceof HTMLAnchorElement) {
      const href = toAbsoluteUrl(node.getAttribute("href"));
      const text = normalizeMarkdownBlock(renderLiveInlineChildren(node, currentStyleState) || node.textContent || "");
      let content = text;

      if (href) {
        if (!text || looksLikeAbsoluteUrl(text)) {
          content = href;
        } else {
          content = `[${escapeMarkdownText(text)}](${href})`;
        }
      }

      return applyLiveInlineStyleState(content, parentStyleState, currentStyleState);
    }

    if (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") {
      const text = normalizeInlineText(node.textContent || "");
      const content = text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
      return applyLiveInlineStyleState(content, parentStyleState, currentStyleState);
    }

    const content = renderLiveInlineChildren(node, currentStyleState);
    return applyLiveInlineStyleState(content, parentStyleState, currentStyleState);
  }

  function createLiveInlineStyleState(overrides = {}) {
    return {
      bold: Boolean(overrides.bold),
      italic: Boolean(overrides.italic),
      strike: Boolean(overrides.strike)
    };
  }

  function getLiveInlineStyleState(element, parentStyleState) {
    const currentStyleState = createLiveInlineStyleState(parentStyleState);

    if (element instanceof HTMLElement) {
      const style = window.getComputedStyle(element);
      currentStyleState.bold = Number(style.fontWeight) >= 600;
      currentStyleState.italic = style.fontStyle.includes("italic");
      currentStyleState.strike = style.textDecorationLine.includes("line-through");
    }

    if (element.tagName === "STRONG" || element.tagName === "B") {
      currentStyleState.bold = true;
    }

    if (element.tagName === "EM" || element.tagName === "I") {
      currentStyleState.italic = true;
    }

    if (element.tagName === "DEL" || element.tagName === "S" || element.tagName === "STRIKE") {
      currentStyleState.strike = true;
    }

    return currentStyleState;
  }

  function applyLiveInlineStyleState(content, parentStyleState, currentStyleState) {
    if (!content || !normalizeText(content)) {
      return content;
    }

    let formatted = content;

    if (currentStyleState.bold && !parentStyleState.bold) {
      formatted = `**${formatted}**`;
    }

    if (currentStyleState.italic && !parentStyleState.italic) {
      formatted = `*${formatted}*`;
    }

    if (currentStyleState.strike && !parentStyleState.strike) {
      formatted = `~~${formatted}~~`;
    }

    return formatted;
  }

  window.__x2markdownShared = {
    buildGenericMarkdown,
    cleanPageUrl,
    collectTextTokens,
    convertNodeToMarkdown,
    copyToClipboard,
    extractInlineMarkdown,
    extractSelectionPayload,
    firstVisibleElement,
    formatAuthor,
    formatTimeValue,
    getDisplaySiteName,
    isVisible,
    normalizeMarkdownBlock,
    normalizeMediaUrl,
    normalizeText,
    showToast,
    t,
    toAbsoluteUrl,
    unique,
    uniqueByKey
  };
})();
