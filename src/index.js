const DEFAULT_PROXY_PREFIX = "";
const PAGE_KEY_ENDPOINT =
  "https://ebooksapi.rekhta.org/api_getebookpagebyid_websiteapp/?wref=from-site&&pgid=";
const DEFAULT_TILE_SIZE = 50;
const DEFAULT_TILE_GAP = 16;

const memoryJsonCache = new Map();

export {
  DEFAULT_PROXY_PREFIX,
  createBookClient,
  createLimiter,
  getDeviceProfile,
};

function createBookClient(options = {}) {
  const proxyPrefix = options.proxyPrefix || DEFAULT_PROXY_PREFIX;
  const jsonCache = options.jsonCache || createJsonCache();
  const fetchImpl = options.fetchImpl || fetch.bind(globalThis);
  const tileSize = options.tileSize || DEFAULT_TILE_SIZE;
  const tileGap = options.tileGap || DEFAULT_TILE_GAP;

  return {
    buildManifestUrl: (bookUrl) => buildManifestUrl(bookUrl),
    getManifest,
    getPageKey,
    fetchImageBlob,
    proxyPrefix,
    renderPageToCanvas,
    renderPageToBlob,
  };

  async function getManifest(bookUrl, fetchOptions = {}) {
    const manifestUrl = buildManifestUrl(bookUrl);
    const html = await getCachedText(manifestUrl, fetchOptions);
    return normalizeManifest(bookUrl, html);
  }

  async function getPageKey(pageId, fetchOptions = {}) {
    const keyUrl = applyProxyPrefix(
      `${PAGE_KEY_ENDPOINT}${encodeURIComponent(pageId)}`,
      proxyPrefix,
    );
    return getCachedJson(keyUrl, fetchOptions);
  }

  async function fetchImageBlob(imageUrl, fetchOptions = {}) {
    const response = await fetchImpl(applyProxyPrefix(imageUrl, proxyPrefix), {
      method: "GET",
      mode: "cors",
      cache: "force-cache",
      signal: fetchOptions.signal,
    });

    if (!response.ok) {
      throw new Error(`Image fetch failed with status ${response.status}`);
    }

    return response.blob();
  }

  async function renderPageToCanvas(pageReference, fetchOptions = {}) {
    if (!pageReference?.pageId || !pageReference?.imgUrl) {
      throw new Error("Page reference is missing pageId or imgUrl.");
    }

    const [pageKey, imageBlob] = await Promise.all([
      getPageKey(pageReference.pageId, fetchOptions),
      fetchImageBlob(pageReference.imgUrl, fetchOptions),
    ]);

    return unscramblePage({
      imageBlob,
      pageKey,
      tileGap,
      tileSize,
    });
  }

  async function renderPageToBlob(pageReference, fetchOptions = {}) {
    const canvas = await renderPageToCanvas(pageReference, fetchOptions);
    const type = fetchOptions.type || "image/jpeg";
    const quality = fetchOptions.quality ?? 0.86;
    const blob = await canvasToBlob(canvas, type, quality);

    return {
      blob,
      canvas,
      height: canvas.height,
      pageId: pageReference.pageId,
      width: canvas.width,
    };
  }

  async function getCachedJson(url, fetchOptions = {}) {
    if (!fetchOptions.forceRefresh) {
      const cachedValue = await jsonCache.match(url);
      if (cachedValue) {
        return cachedValue;
      }
    }

    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      mode: "cors",
      signal: fetchOptions.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    await jsonCache.put(url, payload);
    return payload;
  }

  async function getCachedText(url, fetchOptions = {}) {
    if (!fetchOptions.forceRefresh) {
      const cachedValue = await jsonCache.match(url);
      if (typeof cachedValue === "string") {
        return cachedValue;
      }
    }

    const response = await fetchImpl(applyProxyPrefix(url, proxyPrefix), {
      method: "GET",
      mode: "cors",
      signal: fetchOptions.signal,
    });

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.text();
    await jsonCache.put(url, payload);
    return payload;
  }
}

function buildManifestUrl(bookUrl) {
  return bookUrl;
}

function normalizeManifest(bookUrl, html) {
  if (!html) {
    throw new Error("Manifest HTML is empty.");
  }

  const parser = new DOMParser();
  const documentNode = parser.parseFromString(html, "text/html");
  const bookName =
    documentNode.querySelector("span.c-book-name")?.textContent?.trim() ||
    documentNode.querySelector("title")?.textContent?.trim() ||
    "Untitled book";
  const author =
    documentNode
      .querySelector("span.faded")
      ?.textContent?.replace(/\r?\n/g, "")
      .replace(/ +/g, " ")
      .replace("by ", "")
      .trim() || "Unknown author";
  const bookId = findTextBetween(html, 'var bookId = "', '";');
  const pages = stringToStringArray(findTextBetween(html, "var pages = [", "];"));
  const pageIds = stringToStringArray(
    findTextBetween(html, "var pageIds = [", "];"),
  );
  const pageCount =
    Number(findTextBetween(html, "var totalPageCount =", ";")) ||
    Math.max(pages.length, pageIds.length);
  const fileName = `${bookName} by ${author}`
    .trim()
    .replace(/ +/g, " ")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
  const scrambleMap = pageIds.map((pageId, index) => ({
    imageName: pages[index] || "",
    imgUrl: `https://ebooksapi.rekhta.org/images/${bookId}/${pages[index]}`,
    index,
    keyUrl: `${PAGE_KEY_ENDPOINT}${encodeURIComponent(pageId)}`,
    pageId,
  }));

  return {
    actualUrl: bookUrl,
    author,
    bookId,
    bookName,
    bookUrl,
    fileName: fileName || "rekhta-book",
    pageCount,
    pageIds,
    pages,
    scrambleMap,
  };
}

function applyProxyPrefix(url, proxyPrefix) {
  if (!proxyPrefix) {
    return url;
  }

  if (proxyPrefix.includes("{url}")) {
    return proxyPrefix.replace("{url}", encodeURIComponent(url));
  }

  return `${proxyPrefix}${encodeURIComponent(url)}`;
}

async function unscramblePage(options) {
  const { imageBlob, pageKey, tileGap, tileSize } = options;
  const source = await loadImageSource(imageBlob);
  const canvas = document.createElement("canvas");
  canvas.width = pageKey.PageWidth || tileSize * (pageKey.X || 1);
  canvas.height = pageKey.PageHeight || tileSize * (pageKey.Y || 1);

  const ctx = canvas.getContext("2d", { alpha: false });
  const tileStride = tileSize + tileGap;

  pageKey.Sub.forEach((sub) => {
    ctx.drawImage(
      source,
      sub.X1 * tileStride,
      sub.Y1 * tileStride,
      tileSize,
      tileSize,
      sub.X2 * tileSize,
      sub.Y2 * tileSize,
      tileSize,
      tileSize,
    );
  });

  releaseImageSource(source);
  return canvas;
}

async function loadImageSource(imageBlob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(imageBlob);
  }

  const objectUrl = URL.createObjectURL(imageBlob);

  try {
    const image = new Image();
    image.decoding = "async";

    const loaded = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to decode page image."));
    });

    image.src = objectUrl;
    return await loaded;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function releaseImageSource(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    source.close();
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Unable to encode canvas output."));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

function createJsonCache() {
  const cacheName = "rekhta-downloader-json-v1";

  return {
    async match(url) {
      const cacheStorage = await getCacheStorage();
      if (!cacheStorage) {
        return memoryJsonCache.get(url) || null;
      }

      const response = await cacheStorage.match(url);
      if (!response) {
        return memoryJsonCache.get(url) || null;
      }

      return response.json();
    },
    async put(url, payload) {
      memoryJsonCache.set(url, payload);

      const cacheStorage = await getCacheStorage();
      if (!cacheStorage) {
        return;
      }

      const response = new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json",
        },
      });

      await cacheStorage.put(url, response);
    },
  };

  async function getCacheStorage() {
    if (!("caches" in globalThis)) {
      return null;
    }

    return caches.open(cacheName);
  }
}

function findTextBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) {
    return "";
  }

  const fromIndex = startIndex + start.length;
  const endIndex = source.indexOf(end, fromIndex);
  if (endIndex === -1) {
    return "";
  }

  return source.slice(fromIndex, endIndex).trim();
}

function stringToStringArray(input) {
  if (!input) {
    return [];
  }

  return input.split(",").map((item) => item.replace(/"/g, "").trim());
}

function createLimiter(concurrency) {
  const queue = [];
  let activeCount = 0;

  return async (task) => {
    if (activeCount >= concurrency) {
      await new Promise((resolve) => {
        queue.push(resolve);
      });
    }

    activeCount += 1;

    try {
      return await task();
    } finally {
      activeCount -= 1;
      const nextTask = queue.shift();
      if (nextTask) {
        nextTask();
      }
    }
  };
}

function getDeviceProfile() {
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const deviceMemory = navigator.deviceMemory || 4;

  return {
    deviceMemory,
    downloadConcurrency: Math.max(
      1,
      Math.min(2, Math.floor(Math.min(hardwareConcurrency, deviceMemory) / 2)),
    ),
    hardwareConcurrency,
    previewConcurrency: Math.max(
      1,
      Math.min(4, Math.floor((hardwareConcurrency + deviceMemory) / 3)),
    ),
  };
}
