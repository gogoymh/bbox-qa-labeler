import { ChangeEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { openDB } from "idb";
import {
  Download,
  FileText,
  ImagePlus,
  ListPlus,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type ImageAsset = {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  dataUrl: string;
};

type ExportImage = Omit<ImageAsset, "dataUrl">;

type NormalizedBBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PixelBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ExportBBox = NormalizedBBox & {
  index: number;
  pixel: PixelBBox;
};

type DraftState = {
  bboxs: NormalizedBBox[];
  question: string;
  answer: string;
  description: string;
  wordFileName: string | null;
  editingRecordId: string | null;
};

type DatasetRecord = {
  id: string;
  image: ImageAsset;
  bboxs: ExportBBox[];
  question: string;
  answer: string;
  description: string;
  wordFileName: string | null;
  createdAt: string;
};

type ExportRecord = Omit<DatasetRecord, "image"> & {
  image: ExportImage;
};

const EMPTY_DRAFT: DraftState = {
  bboxs: [],
  question: "",
  answer: "",
  description: "",
  wordFileName: null,
  editingRecordId: null,
};

const MIN_BOX_SIZE = 0.006;

const DB_NAME = "cad-qa-label";
const DB_VERSION = 1;
const STATE_STORE = "state";
const STATE_KEY = "app-state";

type PersistedState = {
  images: ImageAsset[];
  records: DatasetRecord[];
  drafts: Record<string, DraftState>;
  activeImageId: string | null;
};

let dbPromise: ReturnType<typeof openDB> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE);
        }
      },
    });
  }

  return dbPromise;
}

async function loadPersistedState(): Promise<PersistedState | null> {
  if (typeof indexedDB === "undefined") return null;

  try {
    const db = await getDb();
    const parsed = (await db.get(STATE_STORE, STATE_KEY)) as Partial<PersistedState> | undefined;
    if (!parsed) return null;

    return {
      images: Array.isArray(parsed.images) ? parsed.images : [],
      records: Array.isArray(parsed.records) ? parsed.records : [],
      drafts: parsed.drafts && typeof parsed.drafts === "object" ? parsed.drafts : {},
      activeImageId: typeof parsed.activeImageId === "string" ? parsed.activeImageId : null,
    };
  } catch {
    return null;
  }
}

async function persistState(state: PersistedState): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;

  try {
    const db = await getDb();
    await db.put(STATE_STORE, state, STATE_KEY);
    return true;
  } catch {
    return false;
  }
}

function createId(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);

  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBox(start: { x: number; y: number }, end: { x: number; y: number }): NormalizedBBox {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return {
    id: "draft",
    x: clamp(x),
    y: clamp(y),
    width: clamp(width),
    height: clamp(height),
  };
}

function toPixelBox(box: NormalizedBBox, image: ImageAsset): PixelBBox {
  return {
    x: Math.round(box.x * image.width),
    y: Math.round(box.y * image.height),
    width: Math.round(box.width * image.width),
    height: Math.round(box.height * image.height),
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getExportImage(image: ImageAsset): ExportImage {
  const { dataUrl: _dataUrl, ...exportImage } = image;
  return exportImage;
}

function getBaseFileName(fileName: string) {
  const withoutPath = fileName.split(/[/\\]/).pop() ?? fileName;
  return withoutPath.replace(/\.[^.]+$/, "") || "cad-qa-label";
}

function sanitizeDownloadName(value: string) {
  return value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._가-힣-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

function buildDownloadFileName(records: DatasetRecord[]) {
  const imageNames = Array.from(new Set(records.map((record) => record.image.name)));
  const firstImageName = sanitizeDownloadName(getBaseFileName(imageNames[0] ?? "cad-qa-label"));

  if (imageNames.length <= 1) {
    return `${firstImageName || "cad-qa-label"}.labels.json`;
  }

  return `${firstImageName || "cad-qa-label"}-and-${imageNames.length - 1}-more.labels.json`;
}

function readImageFile(file: File): Promise<ImageAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error(`${file.name} 파일을 읽지 못했습니다.`));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const image = new Image();

      image.onerror = () => reject(new Error(`${file.name} 이미지 정보를 읽지 못했습니다.`));
      image.onload = () =>
        resolve({
          id: createId("image"),
          name: file.name,
          type: file.type,
          size: file.size,
          width: image.naturalWidth,
          height: image.naturalHeight,
          dataUrl,
        });

      image.src = dataUrl;
    };

    reader.readAsDataURL(file);
  });
}

const PDF_RENDER_SCALE = 2;
const PDF_MAX_DIMENSION = 4000;

let pdfjsModulePromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function getPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }

  return pdfjsModulePromise;
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function estimateDataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

async function readPdfFile(file: File): Promise<ImageAsset[]> {
  const pdfjs = await getPdfjs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const baseName = getBaseFileName(file.name);
    const padWidth = String(pdf.numPages).length;
    const pages: ImageAsset[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const longestSide = Math.max(baseViewport.width, baseViewport.height) || 1;
      const scale = Math.min(PDF_RENDER_SCALE, PDF_MAX_DIMENSION / longestSide);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));

      if (!canvas.getContext("2d")) {
        throw new Error(`${file.name} PDF 페이지를 렌더링하지 못했습니다.`);
      }

      await page.render({ canvas, viewport }).promise;
      page.cleanup();

      const dataUrl = canvas.toDataURL("image/png");
      const suffix = String(pageNumber).padStart(padWidth, "0");

      pages.push({
        id: createId("image"),
        name: `${baseName}-p${suffix}.png`,
        type: "image/png",
        size: estimateDataUrlBytes(dataUrl),
        width: canvas.width,
        height: canvas.height,
        dataUrl,
      });
    }

    if (pages.length === 0) {
      throw new Error(`${file.name} PDF에서 페이지를 찾지 못했습니다.`);
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function buildExportBox(box: NormalizedBBox, image: ImageAsset, index: number): ExportBBox {
  return {
    ...box,
    index,
    pixel: toPixelBox(box, image),
  };
}

function buildExportRecord(record: DatasetRecord): ExportRecord {
  return {
    ...record,
    image: getExportImage(record.image),
  };
}

function upsertRecords(list: DatasetRecord[], record: DatasetRecord): DatasetRecord[] {
  return list.some((item) => item.id === record.id)
    ? list.map((item) => (item.id === record.id ? record : item))
    : [record, ...list];
}

type PendingAction = { kind: "upload"; files: File[] } | { kind: "download" };

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

function App() {
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<NormalizedBBox | null>(null);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [zoom, setZoom] = useState(1);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wordInputRef = useRef<HTMLInputElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadPersistedState().then((state) => {
      if (cancelled) return;

      if (state) {
        setImages(state.images);
        setRecords(state.records);
        setDrafts(state.drafts);
        setActiveImageId(state.activeImageId);
      }
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    const handle = window.setTimeout(() => {
      persistState({ images, records, drafts, activeImageId }).then((saved) => {
        if (!saved) {
          setError(
            "브라우저 저장에 실패했습니다. 데이터가 새로고침 후 사라질 수 있으니 JSON으로 내려받아 두세요.",
          );
        }
      });
    }, 400);

    return () => window.clearTimeout(handle);
  }, [hydrated, images, records, drafts, activeImageId]);

  useEffect(() => {
    if (!pendingAction) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setPendingAction(null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingAction]);

  const activeImage = images.find((image) => image.id === activeImageId) ?? null;
  const currentDraft = activeImageId ? drafts[activeImageId] ?? EMPTY_DRAFT : EMPTY_DRAFT;

  const activeImageRecords = useMemo(
    () => records.filter((record) => record.image.id === activeImageId),
    [activeImageId, records],
  );

  const editingRecord =
    currentDraft.editingRecordId != null
      ? records.find((record) => record.id === currentDraft.editingRecordId) ?? null
      : null;
  const isEditing = editingRecord !== null;

  const trimmedQuestion = currentDraft.question.trim();
  const trimmedAnswer = currentDraft.answer.trim();
  const trimmedDescription = currentDraft.description.trim();

  const hasQuestion = trimmedQuestion.length > 0;
  const hasAnswer = trimmedAnswer.length > 0;
  const hasDescription = trimmedDescription.length > 0;

  // question 을 입력하면 answer 는 필수. bbox 는 선택 사항이다.
  const answerRequiredMissing = hasQuestion && !hasAnswer;
  const hasAnyContent = hasQuestion || hasAnswer || hasDescription;

  const canCommitCurrent = Boolean(activeImage) && hasAnyContent && !answerRequiredMissing;
  const canDownload = records.length > 0 || canCommitCurrent;

  function ensureDraft(imageId: string) {
    setDrafts((previous) =>
      previous[imageId]
        ? previous
        : {
            ...previous,
            [imageId]: { ...EMPTY_DRAFT, bboxs: [] },
          },
    );
  }

  function activateImage(imageId: string) {
    setActiveImageId(imageId);
    ensureDraft(imageId);
    setDraftBox(null);
    setDragStart(null);
    setZoom(1);
  }

  function updateCurrentDraft(updater: (draft: DraftState) => DraftState) {
    if (!activeImageId) return;

    setDrafts((previous) => {
      const draft = previous[activeImageId] ?? EMPTY_DRAFT;

      return {
        ...previous,
        [activeImageId]: updater(draft),
      };
    });
  }

  function resetCurrentDraft() {
    if (!activeImageId) return;

    setDrafts((previous) => ({
      ...previous,
      [activeImageId]: { ...EMPTY_DRAFT, bboxs: [] },
    }));
    setDraftBox(null);
    setDragStart(null);
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter(
      (file) => file.type.startsWith("image/") || isPdfFile(file),
    );
    event.target.value = "";
    if (files.length === 0) return;

    if (images.length > 0 || records.length > 0) {
      setPendingAction({ kind: "upload", files });
      return;
    }

    void loadImages(files);
  }

  async function loadImages(files: File[]) {
    setIsLoadingImages(true);
    setError(null);

    try {
      const loadedGroups = await Promise.all(
        files.map((file) =>
          isPdfFile(file) ? readPdfFile(file) : readImageFile(file).then((image) => [image]),
        ),
      );
      const loadedImages = loadedGroups.flat();
      if (loadedImages.length === 0) return;

      const nextDrafts: Record<string, DraftState> = {};
      loadedImages.forEach((image) => {
        nextDrafts[image.id] = { ...EMPTY_DRAFT, bboxs: [] };
      });

      // 새 파일을 불러오면 기존 작업 데이터를 모두 비우고 새로 시작한다.
      setImages(loadedImages);
      setRecords([]);
      setDrafts(nextDrafts);
      setActiveImageId(loadedImages[0].id);
      setDraftBox(null);
      setDragStart(null);
      setZoom(1);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "이미지를 불러오지 못했습니다.");
    } finally {
      setIsLoadingImages(false);
    }
  }

  function resetAll() {
    setImages([]);
    setRecords([]);
    setDrafts({});
    setActiveImageId(null);
    setDraftBox(null);
    setDragStart(null);
    setZoom(1);
  }

  function confirmPendingAction() {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;

    if (action.kind === "upload") {
      void loadImages(action.files);
    } else {
      downloadDataset();
      resetAll();
    }
  }

  function cancelPendingAction() {
    setPendingAction(null);
  }

  function zoomIn() {
    setZoom((current) => clampZoom(current + ZOOM_STEP));
  }

  function zoomOut() {
    setZoom((current) => clampZoom(current - ZOOM_STEP));
  }

  function resetZoom() {
    setZoom(1);
  }

  function getLayerPoint(event: PointerEvent<HTMLDivElement>) {
    const layer = annotationLayerRef.current;
    if (!layer) return null;

    const rect = layer.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!activeImage) return;

    const point = getLayerPoint(event);
    if (!point) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDraftBox({ id: "draft", x: point.x, y: point.y, width: 0, height: 0 });
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;

    const point = getLayerPoint(event);
    if (!point) return;

    setDraftBox(normalizeBox(dragStart, point));
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart || !draftBox) return;

    const point = getLayerPoint(event);
    const completedBox = point ? normalizeBox(dragStart, point) : draftBox;

    if (completedBox.width >= MIN_BOX_SIZE && completedBox.height >= MIN_BOX_SIZE) {
      updateCurrentDraft((draft) => ({
        ...draft,
        bboxs: [...draft.bboxs, { ...completedBox, id: createId("bbox") }],
      }));
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragStart(null);
    setDraftBox(null);
  }

  function handleWordFileInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      updateCurrentDraft((draft) => ({ ...draft, wordFileName: file.name }));
    }
    event.target.value = "";
  }

  function clearWordFile() {
    updateCurrentDraft((draft) => ({ ...draft, wordFileName: null }));
  }

  function removeBBox(boxId: string) {
    updateCurrentDraft((draft) => ({
      ...draft,
      bboxs: draft.bboxs.filter((box) => box.id !== boxId),
    }));
  }

  function undoBBox() {
    updateCurrentDraft((draft) => ({
      ...draft,
      bboxs: draft.bboxs.slice(0, -1),
    }));
  }

  function buildCurrentRecord(): DatasetRecord | null {
    if (!activeImage || !canCommitCurrent) return null;

    return {
      id: editingRecord ? editingRecord.id : createId("record"),
      image: activeImage,
      bboxs: currentDraft.bboxs.map((box, index) => buildExportBox(box, activeImage, index)),
      question: trimmedQuestion,
      answer: trimmedAnswer,
      description: trimmedDescription,
      wordFileName: currentDraft.wordFileName,
      createdAt: editingRecord ? editingRecord.createdAt : new Date().toISOString(),
    };
  }

  function commitCurrentDraft() {
    const record = buildCurrentRecord();
    if (!record) return;

    setRecords((previous) => upsertRecords(previous, record));
    resetCurrentDraft();
  }

  function removeRecord(recordId: string) {
    setRecords((previous) => previous.filter((record) => record.id !== recordId));
  }

  function loadRecordAsDraft(record: DatasetRecord) {
    if (!images.some((image) => image.id === record.image.id)) {
      setImages((previous) => [record.image, ...previous]);
    }

    setActiveImageId(record.image.id);
    setDrafts((previous) => ({
      ...previous,
      [record.image.id]: {
        bboxs: record.bboxs.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
        question: record.question,
        answer: record.answer,
        description: record.description ?? "",
        wordFileName: record.wordFileName ?? null,
        editingRecordId: record.id,
      },
    }));
    setDraftBox(null);
    setDragStart(null);
  }

  function downloadDataset() {
    const pendingRecord = buildCurrentRecord();
    const exportRecords = pendingRecord ? upsertRecords(records, pendingRecord) : records;
    const jsonRecords = exportRecords.map(buildExportRecord);

    if (exportRecords.length === 0) return;

    const payload = {
      version: 1,
      type: "cad-qa-label",
      exportedAt: new Date().toISOString(),
      recordCount: jsonRecords.length,
      records: jsonRecords,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = buildDownloadFileName(exportRecords);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    if (pendingRecord) {
      setRecords(exportRecords);
      resetCurrentDraft();
    }
  }

  const displayedBoxes = draftBox ? [...currentDraft.bboxs, draftBox] : currentDraft.bboxs;

  return (
    <div className="app">
      <header className="appHeader">
        <div className="brandBlock">
          <h1>CAD QA Label</h1>
          <div className="headerMeta">
            이미지 {images.length}개 · 저장 묶음 {records.length}개
          </div>
        </div>

        <div className="headerActions">
          <input
            ref={fileInputRef}
            className="srOnly"
            type="file"
            accept="image/*,application/pdf,.pdf"
            multiple
            onChange={handleFileInput}
          />
          <button className="button secondary" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} aria-hidden="true" />
            이미지/PDF 업로드
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => setPendingAction({ kind: "download" })}
            disabled={!canDownload}
          >
            <Download size={18} aria-hidden="true" />
            JSON 다운로드
          </button>
        </div>
      </header>

      {error ? <div className="errorBar">{error}</div> : null}

      <main className="workspace">
        <aside className="libraryPanel" aria-label="이미지 목록">
          <div className="panelHeader">
            <h2>이미지</h2>
            <button
              className="iconButton"
              type="button"
              title="이미지/PDF 추가"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="imageList">
            {images.length === 0 ? (
              <button
                className="emptyState"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoadingImages}
              >
                <ImagePlus size={24} aria-hidden="true" />
                {isLoadingImages ? "불러오는 중" : "이미지/PDF 업로드"}
              </button>
            ) : (
              images.map((image) => {
                const imageRecords = records.filter((record) => record.image.id === image.id);
                const isActive = image.id === activeImageId;

                return (
                  <button
                    key={image.id}
                    className={`imageItem ${isActive ? "selected" : ""}`}
                    type="button"
                    onClick={() => activateImage(image.id)}
                  >
                    <img src={image.dataUrl} alt="" />
                    <span>
                      <strong>{image.name}</strong>
                      <small>
                        {image.width}x{image.height} · {formatBytes(image.size)} · {imageRecords.length}개
                      </small>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="recordsBlock">
            <div className="panelHeader compact">
              <h2>저장 묶음</h2>
              <span className="countPill">{records.length}</span>
            </div>

            <div className="recordList">
              {records.length === 0 ? (
                <div className="mutedLine">저장된 묶음 없음</div>
              ) : (
                records.map((record, index) => {
                  const preview = record.description || record.question || record.answer || "";

                  return (
                  <div className="recordItem" key={record.id}>
                    <button className="recordMain" type="button" onClick={() => loadRecordAsDraft(record)}>
                      <strong>#{records.length - index}</strong>
                      <span>{record.image.name}</span>
                      <small>
                        bbox {record.bboxs.length}개
                        {preview ? ` · ${preview.slice(0, 20)}${preview.length > 20 ? "..." : ""}` : ""}
                      </small>
                    </button>
                    <button
                      className="iconButton danger"
                      type="button"
                      title="묶음 삭제"
                      onClick={() => removeRecord(record.id)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        <section className="stagePanel" aria-label="라벨링 작업 영역">
          <div className="stageToolbar">
            <div>
              <h2>{activeImage ? activeImage.name : "이미지 없음"}</h2>
              <span>
                현재 bbox {currentDraft.bboxs.length}개 · 이 이미지 저장 묶음 {activeImageRecords.length}개
              </span>
            </div>
            <div className="toolButtons">
              <div className="zoomControls">
                <button
                  className="iconButton"
                  type="button"
                  title="축소"
                  onClick={zoomOut}
                  disabled={!activeImage || zoom <= ZOOM_MIN}
                >
                  <ZoomOut size={18} aria-hidden="true" />
                </button>
                <button
                  className="zoomLabel"
                  type="button"
                  title="100%로 맞춤"
                  onClick={resetZoom}
                  disabled={!activeImage}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="iconButton"
                  type="button"
                  title="확대"
                  onClick={zoomIn}
                  disabled={!activeImage || zoom >= ZOOM_MAX}
                >
                  <ZoomIn size={18} aria-hidden="true" />
                </button>
              </div>
              <button
                className="iconButton"
                type="button"
                title="마지막 bbox 취소"
                onClick={undoBBox}
                disabled={currentDraft.bboxs.length === 0}
              >
                <Undo2 size={18} aria-hidden="true" />
              </button>
              <button
                className="iconButton"
                type="button"
                title="현재 입력 초기화"
                onClick={resetCurrentDraft}
                disabled={
                  !activeImage ||
                  (currentDraft.bboxs.length === 0 &&
                    !currentDraft.question &&
                    !currentDraft.answer &&
                    !currentDraft.description &&
                    !currentDraft.wordFileName)
                }
              >
                <RotateCcw size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="stageViewport">
            {activeImage ? (
              <div className="imageShell" style={{ width: `${zoom * 100}%` }}>
                <img className="targetImage" src={activeImage.dataUrl} alt={activeImage.name} draggable={false} />
                <div
                  ref={annotationLayerRef}
                  className="annotationLayer"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={() => {
                    setDragStart(null);
                    setDraftBox(null);
                  }}
                >
                  {displayedBoxes.map((box, index) => {
                    const isDraft = box.id === "draft";

                    return (
                      <div
                        className={`bbox ${isDraft ? "draft" : ""}`}
                        key={`${box.id}-${index}`}
                        style={{
                          left: `${box.x * 100}%`,
                          top: `${box.y * 100}%`,
                          width: `${box.width * 100}%`,
                          height: `${box.height * 100}%`,
                        }}
                      >
                        <span>{isDraft ? "new" : index + 1}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <button
                className="stageEmpty"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoadingImages}
              >
                <ImagePlus size={34} aria-hidden="true" />
                이미지/PDF 업로드
              </button>
            )}
          </div>
        </section>

        <aside className="detailsPanel" aria-label="QA 입력">
          <div className="panelHeader">
            <h2>묶음 편집</h2>
            <span className={isEditing ? "editPill" : canCommitCurrent ? "readyPill" : "countPill"}>
              {isEditing ? "수정 중" : canCommitCurrent ? "준비됨" : "작성 중"}
            </span>
          </div>

          <label className="field">
            <span>Description</span>
            <textarea
              value={currentDraft.description}
              placeholder="설명 입력"
              onChange={(event) =>
                updateCurrentDraft((draft) => ({
                  ...draft,
                  description: event.target.value,
                }))
              }
              disabled={!activeImage}
            />
          </label>

          <label className="field">
            <span>Question</span>
            <textarea
              value={currentDraft.question}
              placeholder="질문 입력"
              onChange={(event) =>
                updateCurrentDraft((draft) => ({
                  ...draft,
                  question: event.target.value,
                }))
              }
              disabled={!activeImage}
            />
          </label>

          <label className="field">
            <span>
              Answer
              {hasQuestion ? <em className="requiredMark">필수</em> : null}
            </span>
            <textarea
              value={currentDraft.answer}
              placeholder={hasQuestion ? "답변 입력 (필수)" : "답변 입력"}
              onChange={(event) =>
                updateCurrentDraft((draft) => ({
                  ...draft,
                  answer: event.target.value,
                }))
              }
              disabled={!activeImage}
            />
            {answerRequiredMissing ? (
              <small className="fieldHint">질문을 입력하면 답변은 필수입니다.</small>
            ) : null}
          </label>

          <div className="field">
            <span>Word</span>
            <input
              ref={wordInputRef}
              className="srOnly"
              type="file"
              accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleWordFileInput}
            />
            {currentDraft.wordFileName ? (
              <div className="wordFile">
                <FileText size={16} aria-hidden="true" />
                <span className="wordFileName" title={currentDraft.wordFileName}>
                  {currentDraft.wordFileName}
                </span>
                <button className="iconButton danger" type="button" title="워드 제거" onClick={clearWordFile}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button
                className="button secondary full"
                type="button"
                onClick={() => wordInputRef.current?.click()}
                disabled={!activeImage}
              >
                <Upload size={18} aria-hidden="true" />
                워드 업로드
              </button>
            )}
          </div>

          <div className="formActions">
            <button className="button primary full" type="button" onClick={commitCurrentDraft} disabled={!canCommitCurrent}>
              {isEditing ? <Save size={18} aria-hidden="true" /> : <ListPlus size={18} aria-hidden="true" />}
              {isEditing ? "묶음 수정" : "묶음 추가"}
            </button>
          </div>

          <div className="bboxListHeader">
            <h2>BBox</h2>
            <span>{currentDraft.bboxs.length}</span>
          </div>

          <div className="bboxList">
            {currentDraft.bboxs.length === 0 ? (
              <div className="mutedLine">bbox 없음</div>
            ) : (
              currentDraft.bboxs.map((box, index) => {
                const pixel = activeImage ? toPixelBox(box, activeImage) : null;

                return (
                  <div className="bboxRow" key={box.id}>
                    <div>
                      <strong>#{index + 1}</strong>
                      <small>
                        {pixel
                          ? `${pixel.x}, ${pixel.y}, ${pixel.width}x${pixel.height}`
                          : `${(box.x * 100).toFixed(1)}%, ${(box.y * 100).toFixed(1)}%`}
                      </small>
                    </div>
                    <button className="iconButton danger" type="button" title="bbox 삭제" onClick={() => removeBBox(box.id)}>
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </main>

      {pendingAction ? (
        <div
          className="modalOverlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) cancelPendingAction();
          }}
        >
          <div className="modalCard" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
            <h2 id="confirmTitle">{pendingAction.kind === "upload" ? "새 파일 불러오기" : "JSON 다운로드"}</h2>
            <p>
              {pendingAction.kind === "upload"
                ? "새 이미지/PDF를 불러오면 현재 이미지·저장 묶음·입력 내용이 모두 삭제됩니다. 계속할까요?"
                : "JSON을 내려받으면 현재 데이터가 모두 삭제되고 초기화됩니다. 계속할까요?"}
            </p>
            <div className="modalActions">
              <button className="button secondary" type="button" onClick={cancelPendingAction}>
                취소
              </button>
              <button className="button primary" type="button" onClick={confirmPendingAction}>
                {pendingAction.kind === "upload" ? "불러오기" : "다운로드"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
