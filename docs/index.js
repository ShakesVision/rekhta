import {
  DEFAULT_PROXY_PREFIX,
  createBookClient,
  createLimiter,
  getDeviceProfile,
} from "./src/index.js";

const { jsPDF } = window.jspdf;

const SAMPLE_BOOK_URL =
  "https://www.rekhta.org/ebooks/deewan-ghalib-mirza-ghalib-ebooks";
const DEFAULT_PROXY_TEMPLATE = `${DEFAULT_PROXY_PREFIX}`;
const PROXY_STORAGE_KEY = "rekhta_proxy_prefix";

const deviceProfile = getDeviceProfile();
let bookClient = createBookClient({
  proxyPrefix: DEFAULT_PROXY_TEMPLATE,
});

const elements = {
  bookForm: document.getElementById("book-form"),
  cacheBadge: document.getElementById("cache-badge"),
  cancelButton: document.getElementById("cancel-button"),
  downloadButton: document.getElementById("download-button"),
  metaAuthor: document.getElementById("meta-author"),
  metaPages: document.getElementById("meta-pages"),
  metaTitle: document.getElementById("meta-title"),
  previewGrid: document.getElementById("preview-grid"),
  progressBar: document.getElementById("task-progress"),
  progressLabel: document.getElementById("progress-label"),
  readerClose: document.getElementById("reader-close"),
  readerImage: document.getElementById("reader-image"),
  readerModal: document.getElementById("reader-modal"),
  readerNext: document.getElementById("reader-next"),
  readerPageInput: document.getElementById("reader-page-input"),
  readerPageTotal: document.getElementById("reader-page-total"),
  readerPrev: document.getElementById("reader-prev"),
  statusText: document.getElementById("status-text"),
  proxyInput: document.getElementById("proxy-prefix"),
  urlInput: document.getElementById("book-url"),
};

const state = {
  abortController: null,
  isUrduBook: false,
  manifest: null,
  modalPageIndex: 0,
  pageNodes: [],
  readerRequestToken: 0,
  previewObserver: null,
  previewRequests: new Map(),
  previewUrls: new Map(),
};

const previewLimiter = createLimiter(deviceProfile.previewConcurrency);

elements.urlInput.value = SAMPLE_BOOK_URL;
elements.proxyInput.value =
  localStorage.getItem(PROXY_STORAGE_KEY) || DEFAULT_PROXY_TEMPLATE;
elements.bookForm.addEventListener("submit", onLoadBook);
elements.downloadButton.addEventListener("click", onDownloadPdf);
elements.cancelButton.addEventListener("click", onCancelWork);
elements.readerClose.addEventListener("click", closeReader);
elements.readerPrev.addEventListener("click", () => stepReader("prev"));
elements.readerNext.addEventListener("click", () => stepReader("next"));
elements.readerPageInput.addEventListener("change", onReaderPageInput);
elements.readerModal.addEventListener("click", onReaderBackdropClick);
document.addEventListener("keydown", onDocumentKeydown);

setStatus("Paste a Rekhta URL or use the sample book to load the manifest.");
setProgress(0, "Idle");
renderDeviceHint();

async function onLoadBook(event) {
  event.preventDefault();
  const bookUrl = elements.urlInput.value.trim();
  const proxyPrefix = elements.proxyInput.value.trim();
  if (!bookUrl) {
    setStatus("Enter a book URL before loading.", "error");
    return;
  }

  localStorage.setItem(PROXY_STORAGE_KEY, proxyPrefix);
  bookClient = createBookClient({ proxyPrefix });
  cancelActiveWork();
  resetPreviewState();

  const abortController = new AbortController();
  state.abortController = abortController;

  setBusy(true, "Loading manifest...");
  setProgress(5, "Loading manifest");

  try {
    const manifest = await bookClient.getManifest(bookUrl, {
      signal: abortController.signal,
    });

    state.manifest = manifest;
    state.isUrduBook = /\?lang=ur\b/i.test(bookUrl);
    renderManifest(manifest);
    setBusy(false);
    setProgress(100, "Manifest cached");
    setStatus(
      `Loaded ${manifest.bookName}. Rekhta is fetched through the configured proxy.`,
      "success",
    );
  } catch (error) {
    handleError(
      error,
      "Unable to load the book manifest. Check the proxy prefix.",
    );
  }
}

async function onDownloadPdf() {
  if (!state.manifest) {
    setStatus("Load a book first, then download the PDF.", "error");
    return;
  }

  cancelActiveWork();
  const abortController = new AbortController();
  state.abortController = abortController;

  const pageRefs = state.manifest.scrambleMap;
  const downloadLimiter = createLimiter(deviceProfile.downloadConcurrency);
  const renderJobs = pageRefs.map((pageRef) =>
    downloadLimiter(() =>
      bookClient.renderPageToCanvas(pageRef, {
        signal: abortController.signal,
      }),
    ),
  );

  setBusy(true, "Preparing PDF...");
  setProgress(1, "Preparing PDF");

  let pdfDocument = null;

  try {
    for (let index = 0; index < renderJobs.length; index += 1) {
      const canvas = await renderJobs[index];
      const orientation =
        canvas.width > canvas.height ? "landscape" : "portrait";
      const pageFormat = [canvas.width, canvas.height];

      if (!pdfDocument) {
        pdfDocument = new jsPDF({
          compress: true,
          format: pageFormat,
          orientation,
          unit: "pt",
        });
      } else {
        pdfDocument.addPage(pageFormat, orientation);
      }

      pdfDocument.addImage(
        canvas,
        "JPEG",
        0,
        0,
        canvas.width,
        canvas.height,
        undefined,
        "FAST",
      );
      canvas.width = 1;
      canvas.height = 1;

      const completion = Math.round(((index + 1) / renderJobs.length) * 100);
      setProgress(completion, `Building PDF ${index + 1}/${renderJobs.length}`);
    }

    pdfDocument.save(`${state.manifest.fileName}.pdf`);
    setBusy(false);
    setStatus("PDF export finished.", "success");
  } catch (error) {
    handleError(error, "PDF export stopped before completion.");
  }
}

function onCancelWork() {
  if (!state.abortController) {
    return;
  }

  cancelActiveWork();
  setBusy(false);
  setStatus("Cancelled the active job.", "muted");
  setProgress(0, "Cancelled");
}

function renderManifest(manifest) {
  elements.metaTitle.textContent = manifest.bookName;
  elements.metaAuthor.textContent = manifest.author;
  elements.metaPages.textContent = `${manifest.pageCount} pages`;
  elements.cacheBadge.textContent = state.isUrduBook
    ? "Manifest cached - Urdu navigation enabled"
    : "Manifest cached";
  elements.downloadButton.disabled = false;
  elements.readerPageTotal.textContent = `/ ${manifest.pageCount}`;
  elements.readerPageInput.max = `${manifest.pageCount}`;

  elements.previewGrid.innerHTML = "";
  state.pageNodes = manifest.scrambleMap.map((pageRef, index) => {
    const card = document.createElement("article");
    card.className = "page-card";
    card.dataset.pageIndex = `${index}`;
    card.addEventListener("click", () => openReader(index));

    const number = document.createElement("div");
    number.className = "page-number";
    number.textContent = `Page ${index + 1}`;

    const body = document.createElement("div");
    body.className = "page-body";

    const status = document.createElement("p");
    status.className = "page-status";
    status.textContent = "Waiting to enter view";

    body.appendChild(status);
    card.append(number, body);
    elements.previewGrid.appendChild(card);
    return { body, card, status };
  });

  observePreviewCards();
}

function observePreviewCards() {
  state.previewObserver?.disconnect();
  state.previewObserver = new IntersectionObserver(onPreviewIntersection, {
    rootMargin: "300px 0px",
    threshold: 0.05,
  });

  state.pageNodes.forEach(({ card }) => {
    state.previewObserver.observe(card);
  });
}

function onPreviewIntersection(entries) {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) {
      return;
    }

    const pageIndex = Number(entry.target.dataset.pageIndex);
    schedulePreview(pageIndex);
    state.previewObserver.unobserve(entry.target);
  });
}

function schedulePreview(pageIndex) {
  if (!state.manifest) {
    return Promise.resolve();
  }

  if (state.previewRequests.has(pageIndex)) {
    return state.previewRequests.get(pageIndex);
  }

  const request = previewLimiter(async () => {
    const node = state.pageNodes[pageIndex];
    node.status.textContent = "Decoding preview...";

    const { blob, canvas } = await bookClient.renderPageToBlob(
      state.manifest.scrambleMap[pageIndex],
      {
        quality: 0.78,
        signal: state.abortController?.signal,
        type: "image/jpeg",
      },
    );

    const objectUrl = URL.createObjectURL(blob);
    state.previewUrls.set(pageIndex, objectUrl);

    const image = document.createElement("img");
    image.className = "page-image";
    image.alt = `${state.manifest.bookName} page ${pageIndex + 1}`;
    image.loading = "lazy";
    image.src = objectUrl;

    node.body.innerHTML = "";
    node.body.appendChild(image);
    canvas.width = 1;
    canvas.height = 1;
  })
    .catch((error) => {
      if (error.name === "AbortError") {
        return;
      }

      const node = state.pageNodes[pageIndex];
      node.status.textContent =
        "Preview failed. Scroll away and back to retry.";
      state.previewObserver?.observe(node.card);
    })
    .finally(() => {
      state.previewRequests.delete(pageIndex);
    });

  state.previewRequests.set(pageIndex, request);
  return request;
}

function resetPreviewState() {
  closeReader();
  state.previewObserver?.disconnect();
  state.previewObserver = null;
  state.pageNodes = [];
  state.previewRequests.clear();
  state.isUrduBook = false;
  state.modalPageIndex = 0;

  state.previewUrls.forEach((objectUrl) => {
    URL.revokeObjectURL(objectUrl);
  });

  state.previewUrls.clear();
  elements.previewGrid.innerHTML = "";
  elements.downloadButton.disabled = true;
  elements.cacheBadge.textContent = "No manifest cached yet";
  elements.metaTitle.textContent = "No book loaded";
  elements.metaAuthor.textContent = "Waiting for manifest";
  elements.metaPages.textContent = "0 pages";
  elements.readerPageInput.value = "";
  elements.readerPageTotal.textContent = "/ 0";
}

function cancelActiveWork() {
  state.abortController?.abort();
  state.abortController = null;
}

function setBusy(isBusy, label = "") {
  elements.cancelButton.disabled = !isBusy;
  elements.bookForm.querySelector("button[type='submit']").disabled = isBusy;
  elements.downloadButton.disabled = isBusy || !state.manifest;
  if (label) {
    elements.progressLabel.textContent = label;
  }
}

function setStatus(message, tone = "muted") {
  elements.statusText.textContent = message;
  elements.statusText.dataset.tone = tone;
}

function setProgress(value, label) {
  elements.progressBar.value = value;
  elements.progressLabel.textContent = label;
}

function renderDeviceHint() {
  elements.cacheBadge.textContent = `${deviceProfile.previewConcurrency} preview workers, ${deviceProfile.downloadConcurrency} PDF workers`;
}

function handleError(error, fallbackMessage) {
  if (error.name === "AbortError") {
    return;
  }

  console.error(error);
  state.abortController = null;
  setBusy(false);
  setStatus(`${fallbackMessage} ${error.message}`, "error");
  setProgress(0, "Stopped");
}

function openReader(pageIndex) {
  if (!state.manifest) {
    return;
  }

  state.modalPageIndex = pageIndex;
  elements.readerModal.classList.remove("reader-modal--hidden");
  document.body.style.overflow = "hidden";
  renderReaderPage(pageIndex);
}

function closeReader() {
  elements.readerModal.classList.add("reader-modal--hidden");
  elements.readerImage.removeAttribute("src");
  elements.readerImage.alt = "";
  document.body.style.overflow = "";
}

function onReaderBackdropClick(event) {
  if (event.target === elements.readerModal) {
    closeReader();
  }
}

function onReaderPageInput() {
  if (!state.manifest) {
    return;
  }

  const rawValue = Number(elements.readerPageInput.value);
  if (!Number.isInteger(rawValue)) {
    elements.readerPageInput.value = `${state.modalPageIndex + 1}`;
    return;
  }

  const nextIndex =
    Math.min(Math.max(rawValue, 1), state.manifest.pageCount) - 1;
  state.modalPageIndex = nextIndex;
  renderReaderPage(nextIndex);
}

function stepReader(direction) {
  if (!state.manifest) {
    return;
  }

  const delta = getDirectionalDelta(direction);
  const nextIndex = state.modalPageIndex + delta;

  if (nextIndex < 0 || nextIndex >= state.manifest.pageCount) {
    return;
  }

  state.modalPageIndex = nextIndex;
  renderReaderPage(nextIndex);
}

function getDirectionalDelta(direction) {
  if (state.isUrduBook) {
    return direction === "prev" ? 1 : -1;
  }

  return direction === "prev" ? -1 : 1;
}

async function renderReaderPage(pageIndex) {
  if (!state.manifest) {
    return;
  }

  const requestToken = ++state.readerRequestToken;
  elements.readerPageInput.value = `${pageIndex + 1}`;
  elements.readerPrev.disabled =
    pageIndex + getDirectionalDelta("prev") < 0 ||
    pageIndex + getDirectionalDelta("prev") >= state.manifest.pageCount;
  elements.readerNext.disabled =
    pageIndex + getDirectionalDelta("next") < 0 ||
    pageIndex + getDirectionalDelta("next") >= state.manifest.pageCount;

  try {
    const objectUrl = await ensurePagePreview(pageIndex);
    if (requestToken !== state.readerRequestToken || isReaderClosed()) {
      return;
    }

    elements.readerImage.src = objectUrl;
    elements.readerImage.alt = `${state.manifest.bookName} page ${pageIndex + 1}`;
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
  }
}

async function ensurePagePreview(pageIndex) {
  const existingUrl = state.previewUrls.get(pageIndex);
  if (existingUrl) {
    return existingUrl;
  }

  const inflight = state.previewRequests.get(pageIndex);
  if (inflight) {
    await inflight;
    return state.previewUrls.get(pageIndex);
  }

  await schedulePreview(pageIndex);
  const objectUrl = state.previewUrls.get(pageIndex);
  if (!objectUrl) {
    throw new Error(`Preview for page ${pageIndex + 1} is unavailable.`);
  }

  return objectUrl;
}

function onDocumentKeydown(event) {
  if (isReaderClosed()) {
    return;
  }

  if (event.key === "Escape") {
    closeReader();
    return;
  }

  if (event.key === "ArrowLeft") {
    stepReader("prev");
  }

  if (event.key === "ArrowRight") {
    stepReader("next");
  }
}

function isReaderClosed() {
  return elements.readerModal.classList.contains("reader-modal--hidden");
}
