const DEFAULT_BACKEND_BASE_URL = "https://api.theothermeunfolded.com";
const PAGE_KEY_ENDPOINT =
  "https://ebooksapi.rekhta.org/api_getebookpagebyid_websiteapp/?wref=from-site&&pgid=";
const DEFAULT_TILE_SIZE = 50;
const DEFAULT_TILE_GAP = 16;

const memoryJsonCache = new Map();

export {
  DEFAULT_BACKEND_BASE_URL,
  createBookClient,
  createLimiter,
  getDeviceProfile,
};

function createBookClient(options = {}) {
  const backendBaseUrl = (options.backendBaseUrl || DEFAULT_BACKEND_BASE_URL).replace(
    /\/$/,
    "",
  );
  const jsonCache = options.jsonCache || createJsonCache();
  const fetchImpl = options.fetchImpl || fetch.bind(globalThis);
  const tileSize = options.tileSize || DEFAULT_TILE_SIZE;
  const tileGap = options.tileGap || DEFAULT_TILE_GAP;

  return {
    backendBaseUrl,
    buildManifestUrl: (bookUrl) => buildManifestUrl(bookUrl, backendBaseUrl),
    getManifest,
    getPageKey,
    fetchImageBlob,
    renderPageToCanvas,
    renderPageToBlob,
  };

  async function getManifest(bookUrl, fetchOptions = {}) {
    const manifestUrl = buildManifestUrl(bookUrl, backendBaseUrl);
    const payload = await getCachedJson(manifestUrl, fetchOptions);
    return normalizeManifest(bookUrl, payload);
  }

  async function getPageKey(pageId, fetchOptions = {}) {
    const keyUrl = `${PAGE_KEY_ENDPOINT}${encodeURIComponent(pageId)}`;
    return getCachedJson(keyUrl, fetchOptions);
  }

  async function fetchImageBlob(imageUrl, fetchOptions = {}) {
    const response = await fetchImpl(imageUrl, {
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
}

function buildManifestUrl(bookUrl, backendBaseUrl) {
  return `${backendBaseUrl}/api/rekhtaBook/${encodeURIComponent(bookUrl)}`;
}

function normalizeManifest(bookUrl, payload) {
  const data = payload?.data || payload;
  if (!data) {
    throw new Error("Manifest payload is empty.");
  }

  const pageIds = Array.isArray(data.pageIds) ? data.pageIds : [];
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const scrambleMap = Array.isArray(data.scrambleMap)
    ? data.scrambleMap.map((item, index) => ({
        imageName: pages[index] || item.imgUrl?.split("/").pop() || "",
        imgUrl: item.imgUrl,
        index,
        keyUrl: item.key,
        pageId: pageIds[index] || extractPageId(item.key),
      }))
    : pageIds.map((pageId, index) => ({
        imageName: pages[index] || "",
        imgUrl: `https://ebooksapi.rekhta.org/images/${data._bookId}/${pages[index]}`,
        index,
        keyUrl: `${PAGE_KEY_ENDPOINT}${encodeURIComponent(pageId)}`,
        pageId,
      }));

  return {
    actualUrl: data.actualUrl || "",
    author: data.author || "Unknown author",
    bookId: data._bookId || "",
    bookName: data.bookName || "Untitled book",
    bookUrl,
    fileName: data.fileName || "rekhta-book",
    pageCount:
      Number(data._pageCount) ||
      scrambleMap.length ||
      Math.max(pageIds.length, pages.length),
    pageIds,
    pages,
    scrambleMap,
  };
}

function extractPageId(url) {
  if (!url) {
    return "";
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.searchParams.get("pageid") || parsedUrl.searchParams.get("pgid") || "";
  } catch {
    return "";
  }
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
