(() => {
  "use strict";

  if (window.__x2markdownXInjected) {
    return;
  }

  window.__x2markdownXInjected = true;

  const shared = window.__x2markdownShared;
  if (!shared) {
    return;
  }

  const {
    buildGenericMarkdown,
    cleanPageUrl,
    collectTextTokens,
    copyToClipboard,
    extractInlineMarkdown,
    extractSelectionPayload,
    firstVisibleElement,
    formatAuthor,
    formatTimeValue,
    isVisible,
    normalizeMarkdownBlock,
    normalizeMediaUrl,
    normalizeText,
    showToast,
    t,
    toAbsoluteUrl,
    unique,
    uniqueByKey
  } = shared;

  const STATE = {
    contextMenuTargetNode: null,
    contextMenuPost: null,
    contextMenuStatusUrl: ""
  };

  const COPY_MESSAGE_TYPE = "COPY_MARKDOWN_FROM_PAGE";
  const PATH_PATTERNS = {
    status: /^\/[^/]+\/status\/\d+(?:\/)?$/,
    article: /^\/[^/]+\/article\/\d+(?:\/)?$/
  };

  const SELECTORS = {
    article: 'article[data-testid="tweet"]',
    timelineCell: '[data-testid="cellInnerDiv"]',
    tweetText: '[data-testid="tweetText"]',
    tweetTextShowMore: '[data-testid="tweet-text-show-more-link"]',
    userName: '[data-testid="User-Name"]',
    longformRoot: '[data-testid="twitterArticleReadView"]',
    longformTitle: '[data-testid="twitter-article-title"]',
    longformRichText: '[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]'
  };

  const LONGFORM_BLOCK_SELECTOR = [
    ".longform-header-one",
    ".longform-header-one-narrow",
    ".longform-header-two",
    ".longform-header-two-narrow",
    ".longform-unstyled",
    ".longform-unstyled-narrow",
    ".longform-blockquote",
    ".longform-blockquote-narrow",
    ".longform-unordered-list-item",
    ".longform-unordered-list-item-narrow",
    ".longform-ordered-list-item",
    ".longform-ordered-list-item-narrow",
    'section[data-block="true"]',
    '[data-testid="markdown-code-block"]'
  ].join(", ");

  document.addEventListener("contextmenu", handleContextMenuEvent, true);

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== COPY_MESSAGE_TYPE) {
        return undefined;
      }

      void handleCopyRequest(message.mode || "main")
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : t("errorCopyFailedGeneric", undefined, "Copy failed");
          console.error("[x2markdown] 复制失败", error);
          showToast(errorMessage);
          sendResponse({
            ok: false,
            error: errorMessage
          });
        });

      return true;
    });
  }

  async function handleCopyRequest(mode) {
    if (mode === "selection") {
      const selectionPayload = extractSelectionPayload();
      if (!selectionPayload) {
        throw new Error(t("errorNoValidSelection", undefined, "No valid selection found"));
      }
      await copyToClipboard(buildGenericMarkdown(selectionPayload));
      showToast(t("toastCopiedSelectionAsMarkdown", undefined, "Copied selection as Markdown"));
      return;
    }

    const pageType = getSupportedPageType(location.pathname);
    const payload =
      pageType === "status"
        ? await extractCurrentStatusPage()
        : pageType === "article"
          ? await extractCurrentArticlePage()
          : await extractContextMenuPostPage();
    const markdown = buildMarkdown(payload);

    await copyToClipboard(markdown);
    showToast(t("toastCopiedBodyAsMarkdown", undefined, "Copied body as Markdown"));
  }

  function getSupportedPageType(pathname) {
    if (PATH_PATTERNS.status.test(pathname)) {
      return "status";
    }

    if (PATH_PATTERNS.article.test(pathname)) {
      return "article";
    }

    return null;
  }

  async function extractCurrentStatusPage() {
    const longformRoot = getLongformRoot();
    if (longformRoot) {
      const payload = extractArticleData(longformRoot);
      return {
        ...payload,
        url: cleanPageUrl(location.href)
      };
    }

    const article = await expandTweetTextIfNeeded(getStatusPageArticle(), {
      resolveArticle: getStatusPageArticle
    });
    const posts = await extractStatusThreadPosts(article);

    if (posts.length <= 1) {
      return {
        ...posts[0],
        url: cleanPageUrl(location.href)
      };
    }

    return {
      kind: "thread",
      url: cleanPageUrl(location.href),
      posts
    };
  }

  async function extractStatusThreadPosts(mainArticle) {
    const articles = await collectStatusThreadArticles(mainArticle);
    const posts = [];

    for (let index = 0; index < articles.length; index += 1) {
      posts.push(await extractPostData(articles[index], {
        allowMediaOnly: index > 0,
        expandQuotedPost: index === 0 && articles.length === 1
      }));
    }

    return posts;
  }

  async function extractPostData(article, options = {}) {
    const { allowMediaOnly = false, expandQuotedPost = false } = options;

    if (!(article instanceof HTMLElement)) {
      throw new Error(t("errorInvalidPostNode", undefined, "Invalid post node"));
    }

    const currentStatusId = getSupportedPageType(location.pathname) === "status" ? extractPathId(location.pathname, "status") : "";
    const articleStatusId = extractStatusIdFromArticle(article);
    const statusId = currentStatusId && articleHasStatusId(article, currentStatusId) ? currentStatusId : articleStatusId;
    const author = extractAuthor(article);
    const timeInfo = extractStatusTime(article, statusId);
    const timeElement = timeInfo.element;
    const statusUrl = extractStatusUrl(article, timeElement);
    const textElement = findPrimaryTweetText(article);
    let quote = extractQuotedPost(article, {
      primaryTextNode: textElement,
      currentStatusUrl: statusUrl
    });
    const body = textElement ? normalizeMarkdownBlock(extractInlineMarkdown(textElement)) : "";
    const images = extractPostImages(article, {
      excludeContainer: quote ? quote.container : null
    });

    if (expandQuotedPost && quote && quote.isTruncated) {
      quote = await expandQuotedPostData(quote);
    }

    if (!author.displayName && !author.handle) {
      throw new Error(t("errorAuthorInfoNotFound", undefined, "Author information not found"));
    }

    if (!timeElement) {
      throw new Error(t("errorPublishTimeNotFound", undefined, "Publish time not found"));
    }

    if (!statusUrl) {
      throw new Error(t("errorPostLinkNotFound", undefined, "Post link not found"));
    }

    if (!body && !(allowMediaOnly && (images.length > 0 || quote))) {
      throw new Error(t("errorBodyNotFound", undefined, "Body content not found"));
    }

    return {
      kind: "post",
      title: "",
      author,
      time: formatTimeValue(timeInfo.datetime, timeInfo.text),
      url: statusUrl,
      body,
      images,
      quote
    };
  }

  async function expandQuotedPostData(quote) {
    const fallbackQuote = quote;
    const originalUrl = location.href;
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    const navigationTarget = findQuotedPostNavigationTarget(quote);

    if (!(navigationTarget instanceof HTMLElement)) {
      return fallbackQuote;
    }

    try {
      navigationTarget.click();

      const didNavigate = await waitForUrlChange(originalUrl, 3500);
      if (!didNavigate || getSupportedPageType(location.pathname) !== "status") {
        return fallbackQuote;
      }

      const quoteArticle = await waitForCurrentStatusArticle(5000);
      const expandedArticle = await expandTweetTextIfNeeded(quoteArticle, {
        resolveArticle: getStatusPageArticle
      });
      const expandedUrl = cleanPageUrl(location.href);
      const post = await extractPostData(expandedArticle, {
        allowMediaOnly: true,
        expandQuotedPost: false
      });

      if (!post || !post.body || post.body.length <= fallbackQuote.body.length) {
        return fallbackQuote;
      }

      return {
        author: post.author,
        time: post.time,
        url: expandedUrl || post.url,
        body: post.body,
        images: post.images,
        container: fallbackQuote.container,
        isTruncated: false
      };
    } catch (error) {
      return fallbackQuote;
    } finally {
      await restoreOriginalStatusPage(originalUrl, originalScrollX, originalScrollY);
    }
  }

  function findQuotedPostNavigationTarget(quote) {
    const container = quote && quote.container instanceof HTMLElement ? quote.container : null;
    if (!container) {
      return null;
    }

    if (container.matches('[role="link"]')) {
      return container;
    }

    return container.closest('[role="link"]');
  }

  async function waitForUrlChange(originalUrl, timeout) {
    const startedAt = Date.now();
    const originalCleanUrl = cleanPageUrl(originalUrl);

    while (Date.now() - startedAt < timeout) {
      await wait(80);
      if (cleanPageUrl(location.href) !== originalCleanUrl) {
        return true;
      }
    }

    return false;
  }

  async function waitForCurrentStatusArticle(timeout) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      await wait(80);

      try {
        const article = getStatusPageArticle();
        if (article instanceof HTMLElement) {
          return article;
        }
      } catch (error) {
        // The X route changed before the new status article finished rendering.
      }
    }

    throw new Error(t("errorCurrentPostBodyNotFound", undefined, "Current post body not found"));
  }

  async function restoreOriginalStatusPage(originalUrl, scrollX, scrollY) {
    if (cleanPageUrl(location.href) !== cleanPageUrl(originalUrl)) {
      history.back();
      await waitForSpecificUrl(originalUrl, 5000);
    }

    try {
      window.scrollTo(scrollX, scrollY);
    } catch (error) {
      // Restoring scroll is best-effort after X re-renders the route.
    }
  }

  async function waitForSpecificUrl(expectedUrl, timeout) {
    const startedAt = Date.now();
    const expectedCleanUrl = cleanPageUrl(expectedUrl);

    while (Date.now() - startedAt < timeout) {
      await wait(80);
      if (cleanPageUrl(location.href) === expectedCleanUrl) {
        return true;
      }
    }

    return false;
  }

  async function extractCurrentArticlePage() {
    const root = getArticlePageRoot();
    const payload = extractArticleData(root);

    return {
      ...payload,
      url: cleanPageUrl(location.href)
    };
  }

  function handleContextMenuEvent(event) {
    const pageType = getSupportedPageType(location.pathname);
    if (pageType) {
      clearContextMenuTarget();
      return;
    }

    const article = findContextMenuArticle(event.target);
    if (!(article instanceof HTMLElement) || !isVisible(article)) {
      clearContextMenuTarget();
      return;
    }

    const statusUrl = extractPrimaryStatusUrl(article);
    if (!statusUrl) {
      clearContextMenuTarget();
      return;
    }

    STATE.contextMenuTargetNode = event.target instanceof Node ? event.target : null;
    STATE.contextMenuPost = article;
    STATE.contextMenuStatusUrl = statusUrl;
  }

  async function extractContextMenuPostPage() {
    const article = await expandTweetTextIfNeeded(resolveContextMenuPostArticle(), {
      resolveArticle: resolveContextMenuPostArticle
    });
    return extractPostData(article);
  }

  async function expandTweetTextIfNeeded(article, options = {}) {
    const { resolveArticle = () => article } = options;
    let currentArticle = safelyResolveArticle(resolveArticle) || article;

    if (!(currentArticle instanceof HTMLElement)) {
      throw new Error(t("errorPostNotFound", undefined, "Current post not found"));
    }

    for (let index = 0; index < 4; index += 1) {
      const showMoreButton = findTweetTextShowMoreButton(currentArticle);
      if (!(showMoreButton instanceof HTMLButtonElement)) {
        return currentArticle;
      }

      const previousSnapshot = getTweetTextSnapshot(currentArticle);
      showMoreButton.click();
      await waitForTweetTextExpansion(resolveArticle, previousSnapshot);

      currentArticle = safelyResolveArticle(resolveArticle) || currentArticle;
      if (!(currentArticle instanceof HTMLElement)) {
        throw new Error(t("errorPostNotFound", undefined, "Current post not found"));
      }
    }

    return currentArticle;
  }

  async function waitForTweetTextExpansion(resolveArticle, previousSnapshot) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 1800) {
      await wait(60);

      const article = safelyResolveArticle(resolveArticle);
      if (!(article instanceof HTMLElement)) {
        continue;
      }

      const currentSnapshot = getTweetTextSnapshot(article);
      const hasShowMoreButton = Boolean(findTweetTextShowMoreButton(article));
      if (currentSnapshot !== previousSnapshot || !hasShowMoreButton) {
        await wait(120);
        return;
      }
    }
  }

  function findTweetTextShowMoreButton(article) {
    const candidates = getScopedVisibleElements(article, SELECTORS.tweetTextShowMore, article).filter((node) => {
      return node instanceof HTMLButtonElement && !node.disabled;
    });

    return candidates[0] || null;
  }

  function getTweetTextSnapshot(article) {
    return getScopedVisibleElements(article, SELECTORS.tweetText, article)
      .map((node) => normalizeMarkdownBlock(extractInlineMarkdown(node)))
      .filter(Boolean)
      .join("\n\n");
  }

  function safelyResolveArticle(resolveArticle) {
    try {
      const article = resolveArticle();
      return article instanceof HTMLElement ? article : null;
    } catch (error) {
      return null;
    }
  }

  function resolveContextMenuPostArticle() {
    if (!STATE.contextMenuStatusUrl) {
      throw new Error(t("errorRightClickPostFirst", undefined, "Right-click inside the target post card and try again"));
    }

    if (isReusableContextMenuArticle(STATE.contextMenuPost)) {
      return STATE.contextMenuPost;
    }

    const fallbackArticle = findArticleByStatusUrl(STATE.contextMenuStatusUrl);
    if (fallbackArticle) {
      STATE.contextMenuPost = fallbackArticle;
      return fallbackArticle;
    }

    clearContextMenuTarget();
    throw new Error(t("errorPostNotFound", undefined, "Current post not found"));
  }

  function clearContextMenuTarget() {
    STATE.contextMenuTargetNode = null;
    STATE.contextMenuPost = null;
    STATE.contextMenuStatusUrl = "";
  }

  function isReusableContextMenuArticle(article) {
    return article instanceof HTMLElement && article.isConnected && article.matches(SELECTORS.article) && isVisible(article);
  }

  function findContextMenuArticle(target) {
    const element =
      target instanceof Element ? target : target instanceof Node ? target.parentElement : null;

    if (!(element instanceof Element)) {
      return null;
    }

    const article = element.closest(SELECTORS.article);
    return article instanceof HTMLElement ? article : null;
  }

  function findArticleByStatusUrl(statusUrl) {
    const cleanStatusUrl = cleanPageUrl(statusUrl);
    if (!cleanStatusUrl) {
      return null;
    }

    const candidates = Array.from(document.querySelectorAll(SELECTORS.article)).filter((article) => {
      return article instanceof HTMLElement && isVisible(article) && articleHasStatusUrl(article, cleanStatusUrl);
    });

    return candidates[0] || null;
  }

  function articleHasStatusUrl(article, statusUrl) {
    return Array.from(article.querySelectorAll("a[href]"))
      .map((link) => toAbsoluteUrl(link.getAttribute("href")))
      .map(cleanPageUrl)
      .some((href) => href === statusUrl);
  }

  function extractPrimaryStatusUrl(article) {
    const statusId = extractStatusIdFromArticle(article);
    const timeInfo = extractStatusTime(article, statusId);
    return extractStatusUrl(article, timeInfo.element);
  }

  function getStatusPageArticle() {
    if (getSupportedPageType(location.pathname) !== "status") {
      throw new Error(t("errorUnsupportedPostPage", undefined, "This is not a supported post page"));
    }

    const statusId = extractPathId(location.pathname, "status");
    const candidates = Array.from(document.querySelectorAll(SELECTORS.article)).filter((article) => {
      return article instanceof HTMLElement && isVisible(article) && articleHasStatusId(article, statusId);
    });

    const mainCandidate = candidates.find((article) => article.closest("main"));
    const article = mainCandidate || candidates[0];

    if (!(article instanceof HTMLElement)) {
      throw new Error(t("errorCurrentPostBodyNotFound", undefined, "Current post body not found"));
    }

    return article;
  }

  async function collectStatusThreadArticles(mainArticle) {
    const mainStatusId = extractPathId(location.pathname, "status");
    const mainAuthor = extractAuthor(mainArticle);
    const mainHandle = mainAuthor.handle;
    const collected = [mainArticle];
    const seenStatusIds = new Set([mainStatusId].filter(Boolean));

    if (!mainHandle) {
      return collected;
    }

    const conversationItems = getStatusConversationItems();
    const startIndex = findStatusThreadStartIndex(conversationItems, mainArticle, mainStatusId);
    if (startIndex < 0) {
      return collected;
    }

    for (let index = startIndex + 1; index < conversationItems.length; index += 1) {
      const item = conversationItems[index];
      if (item.type === "skip") {
        continue;
      }

      if (item.type !== "article") {
        break;
      }

      const candidate = item.article;
      const decision = classifyStatusThreadCandidate(candidate, mainHandle, seenStatusIds);

      if (decision.action === "skip") {
        continue;
      }

      if (decision.action === "stop") {
        break;
      }

      const expandedArticle = await expandTweetTextIfNeeded(candidate, {
        resolveArticle: () => resolveStatusConversationArticle(decision.statusId, decision.statusUrl)
      });
      const currentArticle = resolveStatusConversationArticle(decision.statusId, decision.statusUrl) || expandedArticle;

      collected.push(currentArticle);
      if (decision.statusId) {
        seenStatusIds.add(decision.statusId);
      }
    }

    return collected;
  }

  function getStatusConversationArticles() {
    return getStatusConversationItems()
      .filter((item) => item.type === "article")
      .map((item) => item.article);
  }

  function getStatusConversationItems() {
    const main = document.querySelector("main");
    if (!(main instanceof HTMLElement)) {
      return [];
    }

    return Array.from(main.querySelectorAll(SELECTORS.timelineCell))
      .filter((cell) => {
        return cell instanceof HTMLElement && !(cell.parentElement?.closest(SELECTORS.timelineCell) instanceof HTMLElement);
      })
      .map(classifyStatusTimelineCell);
  }

  function classifyStatusTimelineCell(cell) {
    if (!(cell instanceof HTMLElement) || isIgnorableStatusTimelineCell(cell)) {
      return {
        type: "skip",
        article: null
      };
    }

    const article = findTopLevelTimelineArticle(cell);
    if (article) {
      return {
        type: "article",
        article
      };
    }

    return {
      type: "boundary",
      article: null
    };
  }

  function isIgnorableStatusTimelineCell(cell) {
    if (!isVisible(cell)) {
      return true;
    }

    const rect = cell.getBoundingClientRect();
    if (rect.height <= 1) {
      return true;
    }

    if (cell.closest('[data-testid="placementTracking"]')) {
      return true;
    }

    const hasText = Boolean(normalizeText(cell.textContent));
    const hasMedia = Boolean(cell.querySelector("img[src], video"));
    const hasControl = Boolean(cell.querySelector("a[href], button, input, textarea, [role='button']"));

    return !hasText && !hasMedia && !hasControl;
  }

  function findTopLevelTimelineArticle(cell) {
    const articles = Array.from(cell.querySelectorAll(SELECTORS.article)).filter((article) => {
      if (!(article instanceof HTMLElement) || !isVisible(article)) {
        return false;
      }

      if (article.closest(SELECTORS.timelineCell) !== cell) {
        return false;
      }

      return !(article.parentElement?.closest(SELECTORS.article) instanceof HTMLElement);
    });

    return articles[0] || null;
  }

  function findStatusThreadStartIndex(conversationItems, mainArticle, mainStatusId) {
    const directIndex = conversationItems.findIndex((item) => item.type === "article" && item.article === mainArticle);
    if (directIndex >= 0) {
      return directIndex;
    }

    if (!mainStatusId) {
      return -1;
    }

    return conversationItems.findIndex((item) => item.type === "article" && articleHasStatusId(item.article, mainStatusId));
  }

  function classifyStatusThreadCandidate(article, mainHandle, seenStatusIds) {
    if (!(article instanceof HTMLElement) || !isVisible(article)) {
      return { action: "skip", statusId: "", statusUrl: "" };
    }

    if (article.closest('[data-testid="placementTracking"]')) {
      return { action: "skip", statusId: "", statusUrl: "" };
    }

    const statusId = extractStatusIdFromArticle(article);
    const statusUrl = extractPrimaryStatusUrl(article);

    if (!statusId || !statusUrl || seenStatusIds.has(statusId)) {
      return { action: "skip", statusId, statusUrl };
    }

    const author = extractAuthor(article);
    if (!author.handle) {
      return { action: "skip", statusId, statusUrl };
    }

    if (author.handle !== mainHandle) {
      return { action: "stop", statusId, statusUrl };
    }

    return { action: "collect", statusId, statusUrl };
  }

  function resolveStatusConversationArticle(statusId, statusUrl = "") {
    const conversationArticles = getStatusConversationArticles();

    if (statusId) {
      const articleById = conversationArticles.find((article) => articleHasStatusId(article, statusId));
      if (articleById) {
        return articleById;
      }
    }

    if (statusUrl) {
      const cleanStatusUrl = cleanPageUrl(statusUrl);
      return conversationArticles.find((article) => articleHasStatusUrl(article, cleanStatusUrl)) || null;
    }

    return null;
  }

  function articleHasStatusId(article, statusId) {
    const statusPattern = new RegExp(`https://x\\.com/[^/]+/status/${statusId}(?:[/?#]|$)`);
    return Array.from(article.querySelectorAll("a[href]"))
      .map((link) => toAbsoluteUrl(link.getAttribute("href")))
      .some((href) => statusPattern.test(href));
  }

  function extractStatusIdFromArticle(article) {
    const timeElements = Array.from(article.querySelectorAll("time[datetime]")).filter((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        return false;
      }

      return element.closest(SELECTORS.article) === article;
    });

    const linkedTime = timeElements.find((element) => element.closest("a[href]") instanceof HTMLAnchorElement) || null;
    const linkedStatusId =
      linkedTime instanceof HTMLElement ? extractStatusIdFromUrl(linkedTime.closest("a[href]")?.getAttribute("href") || "") : "";

    if (linkedStatusId) {
      return linkedStatusId;
    }

    const statusLinks = Array.from(article.querySelectorAll("a[href]"))
      .map((link) => extractStatusIdFromUrl(link.getAttribute("href") || ""))
      .filter(Boolean);

    return statusLinks[0] || "";
  }

  function getArticlePageRoot() {
    if (getSupportedPageType(location.pathname) !== "article") {
      throw new Error(t("errorUnsupportedArticlePage", undefined, "This is not a supported article page"));
    }

    const longformRoot = getLongformRoot();
    if (longformRoot) {
      return longformRoot;
    }

    const main = document.querySelector("main");
    if (!(main instanceof HTMLElement)) {
      throw new Error(t("errorArticleContainerNotFound", undefined, "Article container not found"));
    }

    const title = firstVisibleElement(main.querySelectorAll("h1"));
    if (!title) {
      throw new Error(t("errorArticleTitleNotFound", undefined, "Article title not found"));
    }

    return main;
  }

  function getLongformRoot() {
    return firstVisibleElement(document.querySelectorAll(SELECTORS.longformRoot));
  }

  function extractPathId(pathname, kind) {
    const pattern = kind === "status" ? PATH_PATTERNS.status : PATH_PATTERNS.article;
    const match = pathname.match(pattern);
    if (!match) {
      throw new Error(t("errorUnsupportedPath", undefined, "Page path is not supported"));
    }

    const segments = pathname.split("/").filter(Boolean);
    return segments[2] || "";
  }

  function extractArticleData(root) {
    if (!(root instanceof HTMLElement)) {
      throw new Error(t("errorInvalidArticleNode", undefined, "Invalid article node"));
    }

    const titleElement = getArticleTitleElement(root);
    if (!titleElement) {
      throw new Error(t("errorArticleTitleNotFound", undefined, "Article title not found"));
    }

    const author = extractLongformAuthor(root);
    const timeInfo = extractLongformTime(root);
    const longformBodyResult = buildLongformBody(root, titleElement);
    const body = longformBodyResult.body || buildArticleBody(root, titleElement);
    const images = extractLongformImages(root).filter((url) => !longformBodyResult.inlineImageUrls.includes(url));

    if (!body) {
      throw new Error(t("errorArticleBodyNotFound", undefined, "Article body not found"));
    }

    return {
      kind: "article",
      title: normalizeText(titleElement.textContent),
      author,
      time: formatTimeValue(timeInfo.datetime, timeInfo.text),
      url: cleanPageUrl(location.href),
      body,
      images,
      quote: null
    };
  }

  function getArticleTitleElement(root) {
    return (
      firstVisibleElement(root.querySelectorAll(SELECTORS.longformTitle)) ||
      firstVisibleElement(root.querySelectorAll("h1.longform-header-one, h1.longform-header-one-narrow, h1"))
    );
  }

  function extractAuthor(root) {
    const candidate = findAuthorNode(root);
    if (!candidate) {
      return {
        displayName: "",
        handle: "",
        profileUrl: ""
      };
    }

    return parseAuthorNode(candidate);
  }

  function parseAuthorNode(candidate) {
    const tokens = collectTextTokens(candidate);
    const handle = tokens.find(isHandleText) || "";
    const displayName =
      tokens.find((token) => token !== handle && !isHandleText(token) && !isMetaToken(token) && !looksLikeCount(token)) ||
      (handle ? handle.replace(/^@/, "") : "");

    const profileUrl =
      unique(
        Array.from(candidate.querySelectorAll("a[href]"))
          .map((link) => toAbsoluteUrl(link.getAttribute("href")))
          .filter((href) => /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/?$/.test(href))
      )[0] || "";

    return {
      displayName,
      handle,
      profileUrl
    };
  }

  function findAuthorNode(root) {
    const candidates = Array.from(root.querySelectorAll(SELECTORS.userName)).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }

      const closestArticle = node.closest(SELECTORS.article);
      return !(root.matches(SELECTORS.article) && closestArticle && closestArticle !== root);
    });

    return candidates[0] || null;
  }

  function findPrimaryTweetText(article) {
    const candidates = getScopedVisibleElements(article, SELECTORS.tweetText, article);

    return candidates[0] || null;
  }

  function extractStatusUrl(root, timeElement) {
    if (timeElement instanceof HTMLElement) {
      const timeLink = timeElement.closest("a[href]");
      if (timeLink instanceof HTMLAnchorElement) {
        return cleanPageUrl(timeLink.href);
      }
    }

    const links = Array.from(root.querySelectorAll("a[href]"))
      .map((link) => toAbsoluteUrl(link.getAttribute("href")))
      .filter((href) => /https:\/\/x\.com\/[^/]+\/status\/\d+/.test(href));

    return links[0] ? cleanPageUrl(links[0]) : "";
  }

  function extractQuotedPost(article, options = {}) {
    const { primaryTextNode = null, currentStatusUrl = "" } = options;
    const textNodes = getScopedVisibleElements(article, SELECTORS.tweetText, article);
    const quoteTextNode = textNodes.find((node) => node !== primaryTextNode) || null;

    if (!(quoteTextNode instanceof HTMLElement)) {
      return null;
    }

    const primaryUserNode = findAuthorNode(article);
    const userNodes = getScopedVisibleElements(article, SELECTORS.userName, article);
    const quoteUserNode = userNodes.find((node) => node !== primaryUserNode) || null;
    const quoteContainer = findQuotedPostContainer(article, quoteTextNode, quoteUserNode, primaryTextNode);
    const author = quoteUserNode ? parseAuthorNode(quoteUserNode) : extractLongformAuthor(quoteContainer);
    const timeInfo = extractQuotedPostTime(quoteContainer, currentStatusUrl);
    const url = extractQuotedStatusUrl(quoteContainer, currentStatusUrl);
    const body = normalizeMarkdownBlock(extractInlineMarkdown(quoteTextNode));
    const images = extractPostImages(quoteContainer, { scopeArticle: article });

    if (!body) {
      return null;
    }

    return {
      author,
      time: formatTimeValue(timeInfo.datetime, timeInfo.text),
      url,
      body,
      images,
      container: quoteContainer,
      isTruncated: isTweetTextTruncated(quoteTextNode)
    };
  }

  function isTweetTextTruncated(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(node);
    const lineClamp = style.webkitLineClamp || style.lineClamp || node.style.webkitLineClamp || "";
    if (lineClamp && lineClamp !== "none" && Number(lineClamp) > 0) {
      return true;
    }

    return node.scrollHeight > node.clientHeight + 2;
  }

  function findQuotedPostContainer(article, quoteTextNode, quoteUserNode, primaryTextNode) {
    let current = quoteTextNode.parentElement;
    while (current && current !== article) {
      if (quoteUserNode && !current.contains(quoteUserNode)) {
        current = current.parentElement;
        continue;
      }

      if (primaryTextNode && current.contains(primaryTextNode)) {
        current = current.parentElement;
        continue;
      }

      return current;
    }

    return quoteTextNode.parentElement || article;
  }

  function extractQuotedPostTime(root, currentStatusUrl) {
    const times = Array.from(root.querySelectorAll("time[datetime]")).filter((element) => {
      return element instanceof HTMLElement && isVisible(element);
    });
    const cleanCurrentStatusUrl = cleanPageUrl(currentStatusUrl);
    const linkedTime = times.find((element) => {
      const link = element.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) {
        return false;
      }

      return cleanPageUrl(link.href) !== cleanCurrentStatusUrl;
    });
    const unlinkedTime = times.find((element) => !(element.closest("a[href]") instanceof HTMLAnchorElement));

    return buildTimeInfo(linkedTime || unlinkedTime || times[0] || null);
  }

  function extractQuotedStatusUrl(root, currentStatusUrl) {
    const cleanCurrentStatusUrl = cleanPageUrl(currentStatusUrl);
    const links = Array.from(root.querySelectorAll("a[href]"))
      .map((link) => toAbsoluteUrl(link.getAttribute("href")))
      .filter((href) => /https:\/\/x\.com\/[^/]+\/status\/\d+/.test(href))
      .map(cleanPageUrl);

    return links.find((href) => href !== cleanCurrentStatusUrl) || "";
  }

  function extractPostImages(root, options = {}) {
    const { scopeArticle = root.closest ? root.closest(SELECTORS.article) : null, excludeContainer = null } = options;
    const images = Array.from(root.querySelectorAll('a[href*="/photo/"] img[src], img[src*="pbs.twimg.com/media"]')).filter((image) => {
      if (!(image instanceof HTMLImageElement) || !isRenderableXMediaImage(image)) {
        return false;
      }

      if (excludeContainer instanceof HTMLElement && excludeContainer.contains(image)) {
        return false;
      }

      const closestArticle = scopeArticle instanceof HTMLElement ? image.closest(SELECTORS.article) : null;
      if (scopeArticle instanceof HTMLElement && closestArticle !== scopeArticle) {
        return false;
      }

      if (image.closest(SELECTORS.userName) || image.closest("[data-testid='UserAvatar-Container']")) {
        return false;
      }

      return image.src.includes("pbs.twimg.com/media");
    });

    return unique(images.map((image) => normalizeMediaUrl(image.src)).filter(Boolean));
  }

  function isRenderableXMediaImage(image) {
    if (!(image instanceof HTMLImageElement)) {
      return false;
    }

    const source = image.currentSrc || image.src || image.getAttribute("src") || "";
    if (!source.includes("pbs.twimg.com/media")) {
      return false;
    }

    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const style = window.getComputedStyle(image);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const container = image.closest('a[href*="/photo/"], [data-testid="tweetPhoto"]') || image.parentElement;
    if (container instanceof HTMLElement) {
      const containerStyle = window.getComputedStyle(container);
      if (containerStyle.display === "none" || containerStyle.visibility === "hidden" || containerStyle.opacity === "0") {
        return false;
      }
    }

    return true;
  }

  function buildLongformBody(root, titleElement) {
    const richTextRoot =
      firstVisibleElement(root.querySelectorAll(SELECTORS.longformRichText)) ||
      firstVisibleElement(root.querySelectorAll(".public-DraftEditor-content")) ||
      root;
    const titleText = normalizeText(titleElement.textContent);
    const blocks = [];
    const inlineImageUrls = [];
    const leadingImageUrls = extractLeadingLongformMediaUrls(root, richTextRoot);

    if (leadingImageUrls.length > 0) {
      blocks.push(renderLongformMediaLinks(leadingImageUrls));
      inlineImageUrls.push(...leadingImageUrls);
    }

    Array.from(richTextRoot.querySelectorAll(LONGFORM_BLOCK_SELECTOR))
      .filter((node) => node instanceof HTMLElement && isVisible(node))
      .forEach((node) => {
        const rendered = renderLongformBlock(node, titleText);
        if (!rendered.text) {
          return;
        }

        blocks.push(rendered.text);
        inlineImageUrls.push(...rendered.imageUrls);
      });

    return {
      body: blocks.join("\n\n").trim(),
      inlineImageUrls: unique(inlineImageUrls)
    };
  }

  function renderLongformBlock(node, titleText) {
    const imageUrls = extractLongformMediaUrls(node);
    if (imageUrls.length > 0) {
      return {
        text: renderLongformMediaLinks(imageUrls),
        imageUrls
      };
    }

    const text = normalizeMarkdownBlock(extractInlineMarkdown(node));
    if (!text || text === titleText) {
      return {
        text: "",
        imageUrls: []
      };
    }

    if (node.matches(".longform-header-one, .longform-header-one-narrow, .longform-header-two, .longform-header-two-narrow")) {
      return {
        text: `## ${text}`,
        imageUrls: []
      };
    }

    if (node.matches(".longform-blockquote, .longform-blockquote-narrow")) {
      return {
        text: text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        imageUrls: []
      };
    }

    if (
      node.matches(
        ".longform-unordered-list-item, .longform-unordered-list-item-narrow, .longform-ordered-list-item, .longform-ordered-list-item-narrow"
      )
    ) {
      return {
        text: `- ${text}`,
        imageUrls: []
      };
    }

    return {
      text,
      imageUrls: []
    };
  }

  function extractLeadingLongformMediaUrls(root, richTextRoot) {
    const containers = Array.from(root.children).filter((child) => {
      return child instanceof HTMLElement && !child.contains(richTextRoot);
    });

    for (const container of containers) {
      const imageUrls = extractLongformMediaUrls(container);
      if (imageUrls.length > 0) {
        return imageUrls;
      }
    }

    return [];
  }

  function renderLongformMediaLinks(imageUrls) {
    return imageUrls.map((url, index) => `[${
      t("markdownImageLabel", String(index + 1), `Image ${index + 1}`)
    }](${url})`).join("\n");
  }

  function extractLongformMediaUrls(root) {
    const urls = [];
    const containers = Array.from(root.querySelectorAll('a[href*="/media/"], img[src]'));

    containers.forEach((node) => {
      if (!(node instanceof HTMLElement) || !isRenderableLongformMediaNode(node)) {
        return;
      }

      const anchor = node instanceof HTMLAnchorElement ? node : node.closest('a[href*="/media/"]');
      const image = node instanceof HTMLImageElement ? node : node.querySelector("img[src]");

      if (image instanceof HTMLImageElement && image.closest("[data-testid='UserAvatar-Container']")) {
        return;
      }

      const imageUrl = image instanceof HTMLImageElement ? normalizeMediaUrl(image.src) : "";
      const mediaUrl = anchor instanceof HTMLAnchorElement ? cleanPageUrl(anchor.href) : "";
      const resolvedUrl = imageUrl.includes("pbs.twimg.com/media") ? imageUrl : mediaUrl;

      if (resolvedUrl) {
        urls.push(resolvedUrl);
      }
    });

    return unique(urls);
  }

  function isRenderableLongformMediaNode(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (node instanceof HTMLImageElement) {
      return isRenderableXMediaImage(node);
    }

    return isVisible(node);
  }

  function buildArticleBody(root, titleElement) {
    const blockSets = [
      collectArticleBodyBlocks(root, titleElement),
      collectArticleBodyBlocks(root, titleElement, { allowInteractiveAncestors: true }),
      collectArticleTweetTextFallback(root, titleElement),
      collectReadableArticleTextFallback(root, titleElement)
    ];

    for (const blocks of blockSets) {
      const body = blocks
        .map((block) => normalizeMarkdownBlock(extractInlineMarkdown(block)))
        .filter(Boolean)
        .filter((text, index, list) => list.indexOf(text) === index)
        .join("\n\n");

      if (body) {
        return body;
      }
    }

    return "";
  }

  function extractLongformAuthor(root) {
    const usernameFromPath = extractUsernameFromPath(location.pathname);
    const candidates = collectProfileLinkCandidates(root).concat(collectProfileLinkCandidates(document));
    const preferredCandidates = candidates.filter((candidate) => {
      return !usernameFromPath || extractUsernameFromUrl(candidate.href) === usernameFromPath;
    });
    const source = preferredCandidates.length > 0 ? preferredCandidates : candidates;
    const profileUrl = source[0] ? source[0].href : "";
    const handle = source.find((candidate) => isHandleText(candidate.text))?.text || "";
    const displayName =
      source.find((candidate) => candidate.text && !isHandleText(candidate.text) && !isMetaToken(candidate.text))?.text ||
      (handle ? handle.replace(/^@/, "") : "");

    return {
      displayName,
      handle,
      profileUrl
    };
  }

  function collectProfileLinkCandidates(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }

    const candidates = Array.from(root.querySelectorAll("a[href]"))
      .filter((link) => link instanceof HTMLAnchorElement && isVisible(link))
      .map((link) => ({
        href: cleanPageUrl(link.href),
        text: normalizeText(link.textContent)
      }))
      .filter((candidate) => /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/?$/.test(candidate.href));

    return uniqueByKey(candidates, (candidate) => `${candidate.href}::${candidate.text}`);
  }

  function extractLongformTime(root) {
    const currentPathId =
      getSupportedPageType(location.pathname) === "status"
        ? extractPathId(location.pathname, "status")
        : extractPathId(location.pathname, "article");
    const linkedTime =
      firstVisibleElement(document.querySelectorAll(`a[href*="/status/${currentPathId}"] time[datetime]`)) || null;
    const rootTime = firstVisibleElement(root.querySelectorAll("time[datetime]"));
    const pageTime = firstVisibleElement(document.querySelectorAll("time[datetime]"));

    return buildTimeInfo(linkedTime || rootTime || pageTime || null);
  }

  function extractLongformImages(root) {
    return extractLongformMediaUrls(root).filter((url) => {
      return url.includes("pbs.twimg.com/media") || /https:\/\/x\.com\/[^/]+\/article\/\d+\/media\/\d+/.test(url);
    });
  }

  function collectArticleBodyBlocks(root, titleElement, options = {}) {
    const { allowInteractiveAncestors = false } = options;
    const titleText = normalizeText(titleElement.textContent);
    const titleBottom = titleElement.getBoundingClientRect().bottom;
    const selector = ["p", "h2", "h3", "blockquote", "li", "pre", "div[dir='auto']"].join(", ");
    const blocks = Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }

      if (node === titleElement || node.contains(titleElement) || titleElement.contains(node)) {
        return false;
      }

      if (node.closest("nav, header, footer, aside, [role='menu'], [role='dialog']")) {
        return false;
      }

      if (node.closest(SELECTORS.userName)) {
        return false;
      }

      if (!allowInteractiveAncestors && node.closest("[role='button'], button")) {
        return false;
      }

      const rect = node.getBoundingClientRect();
      if (rect.bottom <= titleBottom) {
        return false;
      }

      const text = normalizeMarkdownBlock(extractInlineMarkdown(node));
      if (!text || text === titleText) {
        return false;
      }

      if (text.length < 2) {
        return false;
      }

      if (isHandleText(text) || isMetaToken(text) || looksLikeCount(text)) {
        return false;
      }

      return true;
    });

    return blocks.filter((node, index) => {
      return !blocks.some((other, otherIndex) => otherIndex !== index && other.contains(node));
    });
  }

  function collectArticleTweetTextFallback(root, titleElement) {
    const titleBottom = titleElement.getBoundingClientRect().bottom;
    return Array.from(root.querySelectorAll(SELECTORS.tweetText)).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }

      if (node.getBoundingClientRect().bottom <= titleBottom) {
        return false;
      }

      return normalizeMarkdownBlock(extractInlineMarkdown(node)).length > 0;
    });
  }

  function collectReadableArticleTextFallback(root, titleElement) {
    const titleText = normalizeText(titleElement.textContent);
    const titleBottom = titleElement.getBoundingClientRect().bottom;
    const selector = ["div", "p", "h2", "h3", "blockquote", "li", "pre", "span"].join(", ");
    const blocks = Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }

      if (node === titleElement || node.contains(titleElement) || titleElement.contains(node)) {
        return false;
      }

      if (node.closest("nav, header, footer, aside, [role='menu'], [role='dialog']")) {
        return false;
      }

      if (node.closest(SELECTORS.userName)) {
        return false;
      }

      if (node.getBoundingClientRect().bottom <= titleBottom) {
        return false;
      }

      const text = normalizeMarkdownBlock(extractInlineMarkdown(node));
      if (!text || text === titleText || text.length < 28) {
        return false;
      }

      if (isHandleText(text) || isMetaToken(text) || looksLikeCount(text)) {
        return false;
      }

      if (hasReadableChild(node, titleText)) {
        return false;
      }

      return true;
    });

    return blocks.filter((node, index) => {
      return !blocks.some((other, otherIndex) => otherIndex !== index && other.contains(node));
    });
  }

  function hasReadableChild(node, titleText) {
    return Array.from(node.children).some((child) => {
      if (!(child instanceof HTMLElement) || !isVisible(child)) {
        return false;
      }

      const text = normalizeMarkdownBlock(extractInlineMarkdown(child));
      if (!text || text === titleText) {
        return false;
      }

      return text.length >= 28;
    });
  }

  function extractStatusTime(article, statusId) {
    const timeElements = Array.from(article.querySelectorAll("time[datetime]")).filter((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        return false;
      }

      const closestArticle = element.closest(SELECTORS.article);
      return closestArticle === article;
    });

    const matchingElement =
      timeElements.find((element) => {
        const link = element.closest("a[href]");
        return link instanceof HTMLAnchorElement && cleanPageUrl(link.href).includes(`/status/${statusId}`);
      }) || null;

    return buildTimeInfo(matchingElement || timeElements[0] || null);
  }

  function buildTimeInfo(element) {
    if (!(element instanceof HTMLElement)) {
      return {
        element: null,
        datetime: "",
        text: ""
      };
    }

    return {
      element,
      datetime: element.getAttribute("datetime") || "",
      text: normalizeText(element.textContent)
    };
  }

  function buildMarkdown(payload) {
    if (payload.kind === "thread" && Array.isArray(payload.posts)) {
      return buildThreadMarkdown(payload);
    }

    return buildSinglePayloadMarkdown(payload);
  }

  function buildThreadMarkdown(payload) {
    const posts = Array.isArray(payload.posts) ? payload.posts.filter(Boolean) : [];
    const firstPost = posts[0];
    if (!firstPost) {
      return "";
    }

    const lines = [];
    const authorText = formatAuthor(firstPost.author) || t("unknownAuthor", undefined, "Unknown author");
    lines.push(t("markdownAuthorLine", authorText, `Author: ${authorText}`));

    if (firstPost.time) {
      lines.push(t("markdownTimeLine", firstPost.time, `Time: ${firstPost.time}`));
    }

    lines.push(t("markdownLinkLine", payload.url || firstPost.url, `Link: ${payload.url || firstPost.url}`));
    lines.push("", t("markdownBodyLabel", undefined, "Body:"), renderThreadBody(posts));

    return lines.join("\n").trim();
  }

  function buildSinglePayloadMarkdown(payload) {
    const lines = [];
    const images = Array.isArray(payload.images) ? payload.images : [];
    const quote = payload.quote && payload.quote.body ? payload.quote : null;

    if (payload.title) {
      lines.push(`# ${payload.title}`, "");
    }

    const authorText = formatAuthor(payload.author) || t("unknownAuthor", undefined, "Unknown author");
    lines.push(t("markdownAuthorLine", authorText, `Author: ${authorText}`));

    if (payload.time) {
      lines.push(t("markdownTimeLine", payload.time, `Time: ${payload.time}`));
    }

    lines.push(t("markdownLinkLine", payload.url, `Link: ${payload.url}`), "", t("markdownBodyLabel", undefined, "Body:"), payload.body);

    if (quote) {
      lines.push("", t("markdownQuoteSectionLabel", undefined, "Quoted Post:"));
      const quotedAuthorText = formatAuthor(quote.author) || t("unknownAuthor", undefined, "Unknown author");
      lines.push(t("markdownAuthorLine", quotedAuthorText, `Author: ${quotedAuthorText}`));

      if (quote.time) {
        lines.push(t("markdownTimeLine", quote.time, `Time: ${quote.time}`));
      }

      if (quote.url) {
        lines.push(t("markdownLinkLine", quote.url, `Link: ${quote.url}`));
      }

      lines.push(t("markdownBodyLabel", undefined, "Body:"));
      lines.push(
        quote.body
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      );

      if (quote.images.length > 0) {
        lines.push("", t("markdownQuotedImageSectionLabel", undefined, "Quoted Images:"));
        quote.images.forEach((imageUrl, index) => {
          lines.push(`- [${t("markdownQuotedImageLabel", String(index + 1), `Quoted Image ${index + 1}`)}](${imageUrl})`);
        });
      }
    }

    if (images.length > 0) {
      lines.push("", t("markdownImageSectionLabel", undefined, "Images:"));
      images.forEach((imageUrl, index) => {
        lines.push(`- [${t("markdownImageLabel", String(index + 1), `Image ${index + 1}`)}](${imageUrl})`);
      });
    }

    return lines.join("\n").trim();
  }

  function renderThreadBody(posts) {
    return posts
      .map((post) => renderThreadPost(post))
      .filter(Boolean)
      .join("\n\n---\n\n")
      .trim();
  }

  function renderThreadPost(post) {
    const quote = post && post.quote && post.quote.body ? post.quote : null;
    const images = post && Array.isArray(post.images) ? post.images : [];

    if (!post || (!post.body && !quote && images.length === 0)) {
      return "";
    }

    const lines = post.body ? [post.body] : [];

    if (quote) {
      lines.push("", t("markdownQuoteSectionLabel", undefined, "Quoted Post:"));

      const quotedAuthorText = formatAuthor(quote.author) || t("unknownAuthor", undefined, "Unknown author");
      if (quotedAuthorText) {
        lines.push(t("markdownAuthorLine", quotedAuthorText, `Author: ${quotedAuthorText}`));
      }

      if (quote.time) {
        lines.push(t("markdownTimeLine", quote.time, `Time: ${quote.time}`));
      }

      if (quote.url) {
        lines.push(t("markdownLinkLine", quote.url, `Link: ${quote.url}`));
      }

      lines.push(t("markdownBodyLabel", undefined, "Body:"));
      lines.push(
        quote.body
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      );

      if (quote.images.length > 0) {
        lines.push("", t("markdownQuotedImageSectionLabel", undefined, "Quoted Images:"));
        quote.images.forEach((imageUrl, index) => {
          lines.push(`- [${t("markdownQuotedImageLabel", String(index + 1), `Quoted Image ${index + 1}`)}](${imageUrl})`);
        });
      }
    }

    if (images.length > 0) {
      lines.push("", t("markdownImageSectionLabel", undefined, "Images:"));
      images.forEach((imageUrl, index) => {
        lines.push(`- [${t("markdownImageLabel", String(index + 1), `Image ${index + 1}`)}](${imageUrl})`);
      });
    }

    return lines.join("\n").trim();
  }

  function extractStatusIdFromUrl(value) {
    const cleanUrl = toAbsoluteUrl(value);
    const match = cleanUrl.match(/^https:\/\/x\.com\/[^/]+\/status\/(\d+)(?:[/?#]|$)/);
    return match ? match[1] : "";
  }

  function wait(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function looksLikeCount(value) {
    return /^[\d.,]+[KMB万亿]?$/.test(value);
  }

  function isHandleText(value) {
    return /^@[A-Za-z0-9_]{1,15}$/.test(value);
  }

  function isMetaToken(value) {
    return value === "·" || value === "Follow" || value === "Following" || value === "订阅" || value === "已订阅";
  }

  function getScopedVisibleElements(root, selector, scopeArticle = null) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        return false;
      }

      if (!(scopeArticle instanceof HTMLElement)) {
        return true;
      }

      return node.closest(SELECTORS.article) === scopeArticle;
    });
  }

  function extractUsernameFromPath(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    return segments[0] || "";
  }

  function extractUsernameFromUrl(value) {
    try {
      const url = new URL(value, location.origin);
      const segments = url.pathname.split("/").filter(Boolean);
      return segments.length === 1 ? segments[0] : "";
    } catch (error) {
      return "";
    }
  }
})();
