import { ChangeEvent, PointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openDB } from "idb";
import {
  Download,
  FileText,
  FolderOpen,
  ImagePlus,
  ListPlus,
  Maximize,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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

type RecordImage = Omit<ImageAsset, "dataUrl">;

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

// 편집 중인 묶음(아직 저장 전) 상태. Q&A(question/answer)는 제거됨.
type DraftState = {
  bboxs: NormalizedBBox[];
  description: string;
  wordFileName: string | null;
  editingRecordId: string | null;
};

// 저장된 묶음.
type DatasetRecord = {
  id: string;
  image: RecordImage;
  bboxs: ExportBBox[];
  description: string;
  wordFileName: string | null;
  createdAt: string;
};

const EMPTY_DRAFT: DraftState = {
  bboxs: [],
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
  drafts: Record<string, DraftState>;
  records: DatasetRecord[];
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

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

function toRecordImage(image: { dataUrl?: string } & RecordImage): RecordImage {
  return {
    id: image.id,
    name: image.name,
    type: image.type,
    size: image.size,
    width: image.width,
    height: image.height,
  };
}

function normalizeDraft(value: any): DraftState {
  return {
    bboxs: Array.isArray(value?.bboxs)
      ? value.bboxs.map((box: any) => ({
          id: typeof box?.id === "string" ? box.id : createId("bbox"),
          x: clamp(Number(box?.x) || 0),
          y: clamp(Number(box?.y) || 0),
          width: clamp(Number(box?.width) || 0),
          height: clamp(Number(box?.height) || 0),
        }))
      : [],
    description: typeof value?.description === "string" ? value.description : "",
    wordFileName: typeof value?.wordFileName === "string" ? value.wordFileName : null,
    editingRecordId: typeof value?.editingRecordId === "string" ? value.editingRecordId : null,
  };
}

function normalizeRecord(value: any): DatasetRecord | null {
  const image = value?.image;
  if (!image || typeof image.id !== "string") return null;

  return {
    id: typeof value.id === "string" ? value.id : createId("record"),
    image: {
      id: image.id,
      name: typeof image.name === "string" ? image.name : "image",
      type: typeof image.type === "string" ? image.type : "image/png",
      size: Number(image.size) || 0,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
    },
    bboxs: Array.isArray(value.bboxs) ? value.bboxs : [],
    description: typeof value.description === "string" ? value.description : "",
    wordFileName: typeof value.wordFileName === "string" ? value.wordFileName : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  };
}

async function loadPersistedState(): Promise<PersistedState | null> {
  if (typeof indexedDB === "undefined") return null;

  try {
    const db = await getDb();
    const parsed = (await db.get(STATE_STORE, STATE_KEY)) as Record<string, any> | undefined;
    if (!parsed) return null;

    const images: ImageAsset[] = Array.isArray(parsed.images) ? parsed.images : [];

    // drafts 또는 (이전 버전) annotations 를 편집 상태로 정규화한다.
    const rawDrafts =
      parsed.drafts && typeof parsed.drafts === "object"
        ? parsed.drafts
        : parsed.annotations && typeof parsed.annotations === "object"
          ? parsed.annotations
          : {};

    const drafts: Record<string, DraftState> = {};
    Object.keys(rawDrafts).forEach((key) => {
      drafts[key] = normalizeDraft(rawDrafts[key]);
    });

    const records: DatasetRecord[] = Array.isArray(parsed.records)
      ? (parsed.records.map(normalizeRecord).filter(Boolean) as DatasetRecord[])
      : [];

    return {
      images,
      drafts,
      records,
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

// 박스 이동: 정규화 좌표계에서 delta 만큼 옮기되 이미지 밖으로 나가지 않게 한다.
function moveBox(orig: NormalizedBBox, dx: number, dy: number): NormalizedBBox {
  return {
    id: orig.id,
    x: clamp(orig.x + dx, 0, 1 - orig.width),
    y: clamp(orig.y + dy, 0, 1 - orig.height),
    width: orig.width,
    height: orig.height,
  };
}

// 박스 리사이즈: 잡은 핸들(n/s/e/w 조합)에 따라 해당 변만 이동시킨다.
function resizeBox(orig: NormalizedBBox, handle: string, dx: number, dy: number): NormalizedBBox {
  const left = handle.includes("w");
  const right = handle.includes("e");
  const top = handle.includes("n");
  const bottom = handle.includes("s");

  let x1 = orig.x;
  let y1 = orig.y;
  let x2 = orig.x + orig.width;
  let y2 = orig.y + orig.height;

  if (left) x1 = clamp(orig.x + dx, 0, x2 - MIN_BOX_SIZE);
  if (right) x2 = clamp(orig.x + orig.width + dx, x1 + MIN_BOX_SIZE, 1);
  if (top) y1 = clamp(orig.y + dy, 0, y2 - MIN_BOX_SIZE);
  if (bottom) y2 = clamp(orig.y + orig.height + dy, y1 + MIN_BOX_SIZE, 1);

  return { id: orig.id, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function toPixelBox(box: NormalizedBBox, image: { width: number; height: number }): PixelBBox {
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

function buildExportBox(box: NormalizedBBox, image: { width: number; height: number }, index: number): ExportBBox {
  return {
    ...box,
    index,
    pixel: toPixelBox(box, image),
  };
}

function upsertRecords(list: DatasetRecord[], record: DatasetRecord): DatasetRecord[] {
  return list.some((item) => item.id === record.id)
    ? list.map((item) => (item.id === record.id ? record : item))
    : [record, ...list];
}

// 이미지 중심 배열 포맷으로 직렬화한다.
// 최상위는 이미지 배열이고, 각 이미지가 자신의 묶음(records)을 갖는다. (question/answer 제거)
// 이미지 원본(dataUrl)을 포함해, 이 JSON 하나로 다른 환경에서도 그대로 재편집할 수 있게 한다.
function buildExportProject(images: ImageAsset[], records: DatasetRecord[], exportedAt: string) {
  const recordsByImage = new Map<string, DatasetRecord[]>();
  records.forEach((record) => {
    const list = recordsByImage.get(record.image.id) ?? [];
    list.push(record);
    recordsByImage.set(record.image.id, list);
  });

  // 묶음이 저장된 이미지만 내보낸다.
  return images
    .filter((image) => (recordsByImage.get(image.id)?.length ?? 0) > 0)
    .map((image) => ({
      image: {
        id: image.id,
        name: image.name,
        type: image.type,
        size: image.size,
        width: image.width,
        height: image.height,
        dataUrl: image.dataUrl,
      },
      records: (recordsByImage.get(image.id) ?? []).map((record) => ({
        id: record.id,
        type: "description",
        bboxs: record.bboxs,
        description: record.description,
        wordFileName: record.wordFileName,
        createdAt: record.createdAt || exportedAt,
      })),
    }));
}

type ParsedInnerRecord = {
  id?: string;
  bboxs: NormalizedBBox[];
  description: string;
  wordFileName: string | null;
  createdAt: string;
};

type ParsedImage = {
  image: RecordImage;
  dataUrl?: string;
  records: ParsedInnerRecord[];
};

function parseBBoxes(value: any): NormalizedBBox[] {
  return Array.isArray(value)
    ? value.map((box: any) => ({
        id: typeof box?.id === "string" ? box.id : createId("bbox"),
        x: clamp(Number(box?.x) || 0),
        y: clamp(Number(box?.y) || 0),
        width: clamp(Number(box?.width) || 0),
        height: clamp(Number(box?.height) || 0),
      }))
    : [];
}

function parseImageMeta(image: any): { image: RecordImage; dataUrl?: string } | null {
  if (!image || (typeof image.name !== "string" && typeof image.dataUrl !== "string")) return null;
  return {
    image: {
      id: typeof image.id === "string" ? image.id : createId("image"),
      name: typeof image.name === "string" ? image.name : "image",
      type: typeof image.type === "string" ? image.type : "image/png",
      size: Number(image.size) || 0,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
    },
    dataUrl: typeof image.dataUrl === "string" && image.dataUrl ? image.dataUrl : undefined,
  };
}

function parseInnerRecord(record: any): ParsedInnerRecord {
  return {
    id: typeof record?.id === "string" ? record.id : undefined,
    bboxs: parseBBoxes(record?.bboxs),
    description: typeof record?.description === "string" ? record.description : "",
    wordFileName: typeof record?.wordFileName === "string" ? record.wordFileName : null,
    createdAt: typeof record?.createdAt === "string" ? record.createdAt : "",
  };
}

// 여러 포맷을 이미지 중심 배열로 파싱한다:
//  1) 신규: 최상위 배열 [{ image, records: [...] }]
//  2) 기존: { records: [{ image, bboxs, description, ... }] } (이미지 기준으로 묶음)
//  3) 과거(임시): { images: [{ ...image, bboxs, description, ... }] }
function parseProject(data: any): ParsedImage[] | null {
  // 1) 신규 이미지 중심 배열
  if (Array.isArray(data)) {
    const out: ParsedImage[] = [];
    data.forEach((item: any) => {
      const meta = parseImageMeta(item?.image);
      if (!meta) return;
      const records = Array.isArray(item?.records) ? item.records.map(parseInnerRecord) : [];
      out.push({ ...meta, records });
    });
    return out.length ? out : null;
  }

  if (!data || typeof data !== "object") return null;

  // 2) 기존 records 포맷(평면) → 이미지 기준으로 묶음
  if (Array.isArray(data.records)) {
    const byKey = new Map<string, ParsedImage>();
    const order: string[] = [];
    data.records.forEach((record: any) => {
      const meta = parseImageMeta(record?.image);
      if (!meta) return;
      const key = `${meta.image.id}|${meta.image.name}`;
      if (!byKey.has(key)) {
        byKey.set(key, { ...meta, records: [] });
        order.push(key);
      }
      const entry = byKey.get(key)!;
      if (meta.dataUrl && !entry.dataUrl) entry.dataUrl = meta.dataUrl;
      entry.records.push(parseInnerRecord(record));
    });
    const out = order.map((key) => byKey.get(key)!);
    return out.length ? out : null;
  }

  // 3) 과거 images 포맷 → 이미지당 묶음 1개
  if (Array.isArray(data.images)) {
    const out: ParsedImage[] = [];
    data.images.forEach((item: any) => {
      const meta = parseImageMeta(item);
      if (!meta) return;
      out.push({ ...meta, records: [parseInnerRecord(item)] });
    });
    return out.length ? out : null;
  }

  return null;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 1000) / 1000));
}

type Point = { x: number; y: number };

type Interaction =
  | { kind: "draw"; start: Point }
  | { kind: "move"; boxId: string; start: Point; orig: NormalizedBBox }
  | { kind: "resize"; boxId: string; handle: string; start: Point; orig: NormalizedBBox };

const HANDLES: Array<{ dir: string; left: number; top: number; cursor: string }> = [
  { dir: "nw", left: 0, top: 0, cursor: "nwse-resize" },
  { dir: "n", left: 50, top: 0, cursor: "ns-resize" },
  { dir: "ne", left: 100, top: 0, cursor: "nesw-resize" },
  { dir: "e", left: 100, top: 50, cursor: "ew-resize" },
  { dir: "se", left: 100, top: 100, cursor: "nwse-resize" },
  { dir: "s", left: 50, top: 100, cursor: "ns-resize" },
  { dir: "sw", left: 0, top: 100, cursor: "nesw-resize" },
  { dir: "w", left: 0, top: 50, cursor: "ew-resize" },
];

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

function App() {
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [draftBox, setDraftBox] = useState<NormalizedBBox | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);

  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const [zoom, setZoom] = useState(1);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const wordInputRef = useRef<HTMLInputElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);
  const zoomAnchorRef = useRef<{ fracX: number; fracY: number; cursorX: number; cursorY: number } | null>(null);
  const centeredRef = useRef<string | null>(null);

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

  const hasDescription = currentDraft.description.trim().length > 0;
  const hasBBox = currentDraft.bboxs.length > 0;
  // 묶음 추가는 설명(description)과 bbox 가 모두 있을 때만 가능
  const canCommit = Boolean(activeImage) && hasDescription && hasBBox;
  // 저장된 묶음이 있어야만 다운로드 가능
  const canDownload = records.length > 0;

  // 최신 값을 native wheel 리스너에서 참조하기 위한 ref
  const zoomRef = useRef(zoom);
  const activeImageRef = useRef(activeImage);
  zoomRef.current = zoom;
  activeImageRef.current = activeImage;

  // 뷰포트에 맞춰 이미지를 축소해 보여줄 기준 크기 (zoom=1 일 때 화면에 꼭 맞음)
  const baseFit = useMemo(() => {
    if (!activeImage || !viewportSize.w || !viewportSize.h) return null;
    const margin = 40;
    const fit = Math.min(
      (viewportSize.w - margin) / activeImage.width,
      (viewportSize.h - margin) / activeImage.height,
    );
    const baseScale = fit > 1 ? 1 : Math.max(fit, 0.02);
    return { w: activeImage.width * baseScale, h: activeImage.height * baseScale };
  }, [activeImage, viewportSize.w, viewportSize.h]);

  useEffect(() => {
    let cancelled = false;

    loadPersistedState().then((state) => {
      if (cancelled) return;

      if (state) {
        setImages(state.images);
        setDrafts(state.drafts);
        setRecords(state.records);
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
      persistState({ images, drafts, records, activeImageId }).then((saved) => {
        if (!saved) {
          setError(
            "브라우저 저장에 실패했습니다. 데이터가 새로고침 후 사라질 수 있으니 JSON으로 내려받아 두세요.",
          );
        }
      });
    }, 400);

    return () => window.clearTimeout(handle);
  }, [hydrated, images, drafts, records, activeImageId]);

  // 뷰포트 크기 추적
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setViewportSize({ w: rect.width, h: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 이미지를 바꾸면 배율/스크롤을 초기화한다. (zoom=1 이면 화면에 맞아 자동 중앙 정렬)
  useEffect(() => {
    if (!activeImage) return;
    if (centeredRef.current === activeImage.id) return;
    centeredRef.current = activeImage.id;
    setZoom(1);
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }, [activeImage]);

  // 스페이스바: 누르는 동안 패닝 모드
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.code === "Space" || event.key === " ") && !isTypingTarget(event.target)) {
        event.preventDefault();
        setSpaceDown(true);
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.code === "Space" || event.key === " ") {
        setSpaceDown(false);
        setPanning(false);
        panStartRef.current = null;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // 선택된 bbox: Delete/Backspace 로 삭제, Esc 로 모달 닫기 또는 선택 박스 삭제
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;

      if (event.key === "Escape") {
        if (confirmState) {
          setConfirmState(null);
        } else if (selectedBoxId) {
          removeBBox(selectedBoxId);
        }
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && selectedBoxId) {
        event.preventDefault();
        removeBBox(selectedBoxId);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmState, selectedBoxId, activeImageId]);

  // 마우스 휠: 커서 중심 확대/축소 (native 리스너로 passive 해제). 스크롤은 스크롤바/스페이스+드래그로.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    function onWheel(event: WheelEvent) {
      if (!activeImageRef.current) return;
      event.preventDefault();
      const rect = el!.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 확대/축소 후, 기준점(커서) 아래 지점이 유지되도록 스크롤 위치를 보정한다.
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const el = viewportRef.current;
    const canvas = canvasRef.current;
    if (!anchor || !el || !canvas) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = canvas.offsetLeft + anchor.fracX * canvas.offsetWidth - anchor.cursorX;
    el.scrollTop = canvas.offsetTop + anchor.fracY * canvas.offsetHeight - anchor.cursorY;
  }, [zoom]);

  // cursorX/cursorY 는 뷰포트 좌상단 기준 좌표
  function zoomAt(cursorX: number, cursorY: number, factor: number) {
    const el = viewportRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const oldZoom = zoomRef.current;
    const nextZoom = clampZoom(oldZoom * factor);
    if (nextZoom === oldZoom) return;

    const canvasRect = canvas.getBoundingClientRect();
    const viewRect = el.getBoundingClientRect();
    const withinX = viewRect.left + cursorX - canvasRect.left;
    const withinY = viewRect.top + cursorY - canvasRect.top;

    zoomAnchorRef.current = {
      fracX: canvasRect.width ? clamp(withinX / canvasRect.width) : 0.5,
      fracY: canvasRect.height ? clamp(withinY / canvasRect.height) : 0.5,
      cursorX,
      cursorY,
    };
    setZoom(nextZoom);
  }

  function zoomByButton(factor: number) {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function resetView() {
    setZoom(1);
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }

  function ensureDraft(imageId: string) {
    setDrafts((previous) => (previous[imageId] ? previous : { ...previous, [imageId]: { ...EMPTY_DRAFT } }));
  }

  function activateImage(imageId: string) {
    setActiveImageId(imageId);
    ensureDraft(imageId);
    setInteraction(null);
    setDraftBox(null);
    setSelectedBoxId(null);
  }

  function updateCurrentDraft(updater: (draft: DraftState) => DraftState) {
    if (!activeImageId) return;

    setDrafts((previous) => ({
      ...previous,
      [activeImageId]: updater(previous[activeImageId] ?? EMPTY_DRAFT),
    }));
  }

  function resetCurrentDraft() {
    if (!activeImageId) return;
    setDrafts((previous) => ({ ...previous, [activeImageId]: { ...EMPTY_DRAFT } }));
    setDraftBox(null);
    setInteraction(null);
    setSelectedBoxId(null);
  }

  function resetAll() {
    setImages([]);
    setDrafts({});
    setRecords([]);
    setActiveImageId(null);
    setInteraction(null);
    setDraftBox(null);
    setSelectedBoxId(null);
    setError(null);
    setNotice(null);
    setZoom(1);
    centeredRef.current = null;
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }

  function confirmResetAll() {
    if (images.length === 0 && records.length === 0) return;
    setConfirmState({
      title: "전체 초기화",
      message: "모든 이미지·묶음·작업 내용을 삭제하고 처음 상태로 되돌립니다. 이 작업은 되돌릴 수 없습니다. 계속할까요?",
      confirmLabel: "초기화",
      onConfirm: resetAll,
    });
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter(
      (file) => file.type.startsWith("image/") || isPdfFile(file),
    );
    event.target.value = "";
    if (files.length === 0) return;
    void loadImages(files);
  }

  async function loadImages(files: File[]) {
    setIsLoadingImages(true);
    setError(null);
    setNotice(null);

    try {
      const loadedGroups = await Promise.all(
        files.map((file) =>
          isPdfFile(file) ? readPdfFile(file) : readImageFile(file).then((image) => [image]),
        ),
      );
      const loadedImages = loadedGroups.flat();
      if (loadedImages.length === 0) return;

      // 기존 작업은 유지하고 새 이미지를 추가한다.
      setImages((previous) => [...previous, ...loadedImages]);
      setDrafts((previous) => {
        const next = { ...previous };
        loadedImages.forEach((image) => {
          next[image.id] = { ...EMPTY_DRAFT };
        });
        return next;
      });
      setActiveImageId((previous) => previous ?? loadedImages[0].id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "이미지를 불러오지 못했습니다.");
    } finally {
      setIsLoadingImages(false);
    }
  }

  function deleteImage(imageId: string) {
    setImages((previous) => previous.filter((image) => image.id !== imageId));
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[imageId];
      return next;
    });
    setRecords((previous) => previous.filter((record) => record.image.id !== imageId));
    setActiveImageId((previous) => {
      if (previous !== imageId) return previous;
      const remaining = images.filter((image) => image.id !== imageId);
      return remaining[0]?.id ?? null;
    });
    setSelectedBoxId(null);
  }

  function handleImportInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importProject(file);
  }

  async function importProject(file: File) {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const parsedImages = parseProject(data);
      if (!parsedImages) {
        setError("불러올 수 있는 라벨 데이터를 찾지 못했습니다.");
        return;
      }

      // 이미지(dataUrl)가 들어있으면 이미지까지 그대로 복원한다.
      const selfContained = parsedImages.some((parsed) => parsed.dataUrl);

      if (selfContained) {
        const apply = () => {
          const nextImages: ImageAsset[] = [];
          const nextRecords: DatasetRecord[] = [];
          const nextDrafts: Record<string, DraftState> = {};

          parsedImages.forEach((parsed) => {
            if (!parsed.dataUrl) return;
            const image: ImageAsset = { ...parsed.image, dataUrl: parsed.dataUrl };
            nextImages.push(image);
            nextDrafts[image.id] = { ...EMPTY_DRAFT };
            parsed.records.forEach((record) => {
              nextRecords.push({
                id: record.id ?? createId("record"),
                image: parsed.image,
                bboxs: record.bboxs.map((box, index) => buildExportBox(box, parsed.image, index)),
                description: record.description,
                wordFileName: record.wordFileName,
                createdAt: record.createdAt,
              });
            });
          });

          centeredRef.current = null;
          setImages(nextImages);
          setDrafts(nextDrafts);
          setRecords(nextRecords);
          setActiveImageId(nextImages[0]?.id ?? null);
          setInteraction(null);
          setDraftBox(null);
          setSelectedBoxId(null);
          setError(null);
        };

        if (images.length > 0 || records.length > 0) {
          setConfirmState({
            title: "JSON 불러오기",
            message: "현재 작업 내용을 불러온 파일로 대체합니다. 계속할까요?",
            confirmLabel: "불러오기",
            onConfirm: apply,
          });
        } else {
          apply();
        }
        return;
      }

      // 이미지가 없는 예전 JSON: 현재 불러온 이미지에 파일명으로 매칭해 묶음을 복원한다.
      if (images.length === 0) {
        setError("먼저 이미지를 업로드한 뒤 라벨 JSON을 불러오세요. (파일명 기준으로 매칭됩니다)");
        return;
      }

      const matched: DatasetRecord[] = [];
      let matchedImages = 0;
      parsedImages.forEach((parsed) => {
        const image = images.find((image) => image.name === parsed.image.name);
        if (!image) return;
        matchedImages += 1;
        parsed.records.forEach((record) => {
          matched.push({
            id: record.id ?? createId("record"),
            image: toRecordImage(image),
            bboxs: record.bboxs.map((box, index) => buildExportBox(box, image, index)),
            description: record.description,
            wordFileName: record.wordFileName,
            createdAt: record.createdAt,
          });
        });
      });

      if (matchedImages === 0) {
        setError("불러온 라벨과 파일명이 일치하는 이미지가 없습니다. (현재 이미지 목록의 파일명을 확인하세요)");
        return;
      }

      const applyLabels = () => {
        setRecords(matched);
        setDrafts((previous) => {
          const next = { ...previous };
          images.forEach((image) => {
            next[image.id] = { ...EMPTY_DRAFT };
          });
          return next;
        });
        setSelectedBoxId(null);
        setError(null);
        const skipped = parsedImages.length - matchedImages;
        setNotice(
          `묶음 ${matched.length}건을 파일명 기준으로 복원했습니다.${skipped > 0 ? ` (일치하는 이미지가 없어 ${skipped}개 건너뜀)` : ""}`,
        );
      };

      if (records.length > 0) {
        setConfirmState({
          title: "JSON 불러오기",
          message: "현재 저장된 묶음을 불러온 파일의 묶음으로 대체합니다. 계속할까요?",
          confirmLabel: "불러오기",
          onConfirm: applyLabels,
        });
      } else {
        applyLabels();
      }
    } catch {
      setError("JSON 파일을 읽지 못했습니다.");
    }
  }

  function buildCurrentRecord(): DatasetRecord | null {
    if (!activeImage || !canCommit) return null;

    return {
      id: editingRecord ? editingRecord.id : createId("record"),
      image: toRecordImage(activeImage),
      bboxs: currentDraft.bboxs.map((box, index) => buildExportBox(box, activeImage, index)),
      description: currentDraft.description.trim(),
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
      setNotice("이 묶음의 원본 이미지가 목록에 없어 이미지를 표시할 수 없습니다. 같은 이미지를 업로드해 주세요.");
    }

    setActiveImageId(record.image.id);
    setDrafts((previous) => ({
      ...previous,
      [record.image.id]: {
        bboxs: record.bboxs.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
        description: record.description,
        wordFileName: record.wordFileName,
        editingRecordId: record.id,
      },
    }));
    setInteraction(null);
    setDraftBox(null);
    setSelectedBoxId(null);
  }

  function downloadDataset() {
    // 저장된 묶음만 내보낸다. 저장된 묶음이 없으면 다운로드하지 않는다.
    if (records.length === 0) return;

    const exportedAt = new Date().toISOString();
    const project = buildExportProject(images, records, exportedAt);
    if (project.length === 0) return;

    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = buildDownloadFileName(records);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    // 다운로드 후에도 저장된 묶음을 그대로 유지한다.
  }

  function getLayerPoint(event: PointerEvent<HTMLDivElement>): Point | null {
    const layer = annotationLayerRef.current;
    if (!layer) return null;

    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }

  // ---- 도면 위 박스: 그리기 / 이동 / 리사이즈 ----
  function handleLayerPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!activeImage || spaceDown) return; // 스페이스 패닝 중에는 뷰포트가 처리

    const point = getLayerPoint(event);
    if (!point) return;

    const target = event.target as HTMLElement;
    const handle = target.dataset.handle;
    const boxEl = target.closest("[data-box-id]") as HTMLElement | null;
    const boxId = boxEl?.dataset.boxId;

    event.currentTarget.setPointerCapture(event.pointerId);

    if (handle && boxId) {
      const orig = currentDraft.bboxs.find((box) => box.id === boxId);
      if (orig) {
        setSelectedBoxId(boxId);
        setInteraction({ kind: "resize", boxId, handle, start: point, orig });
      }
    } else if (boxId) {
      const orig = currentDraft.bboxs.find((box) => box.id === boxId);
      if (orig) {
        setSelectedBoxId(boxId);
        setInteraction({ kind: "move", boxId, start: point, orig });
      }
    } else {
      setSelectedBoxId(null);
      setInteraction({ kind: "draw", start: point });
      setDraftBox({ id: "draft", x: point.x, y: point.y, width: 0, height: 0 });
    }
  }

  function handleLayerPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!interaction) return;

    const point = getLayerPoint(event);
    if (!point) return;

    if (interaction.kind === "draw") {
      setDraftBox(normalizeBox(interaction.start, point));
      return;
    }

    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const next =
      interaction.kind === "move"
        ? moveBox(interaction.orig, dx, dy)
        : resizeBox(interaction.orig, interaction.handle, dx, dy);

    updateCurrentDraft((draft) => ({
      ...draft,
      bboxs: draft.bboxs.map((box) => (box.id === interaction.boxId ? { ...next, id: box.id } : box)),
    }));
  }

  function handleLayerPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (interaction?.kind === "draw" && draftBox) {
      if (draftBox.width >= MIN_BOX_SIZE && draftBox.height >= MIN_BOX_SIZE) {
        const committed = { ...draftBox, id: createId("bbox") };
        updateCurrentDraft((draft) => ({ ...draft, bboxs: [...draft.bboxs, committed] }));
        setSelectedBoxId(committed.id);
      }
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setInteraction(null);
    setDraftBox(null);
  }

  // ---- 뷰포트 패닝 (스페이스 + 드래그): 네이티브 스크롤 위치를 옮긴다 ----
  function handleViewportPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!spaceDown || !activeImage) return;
    const el = event.currentTarget;
    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setPanning(true);
    el.setPointerCapture(event.pointerId);
  }

  function handleViewportPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = panStartRef.current;
    if (!start) return;
    const el = event.currentTarget;
    el.scrollLeft = start.scrollLeft - (event.clientX - start.clientX);
    el.scrollTop = start.scrollTop - (event.clientY - start.clientY);
  }

  function handleViewportPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
    panStartRef.current = null;
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
    setSelectedBoxId((previous) => (previous === boxId ? null : previous));
  }

  function undoLastBBox() {
    updateCurrentDraft((draft) => ({ ...draft, bboxs: draft.bboxs.slice(0, -1) }));
  }

  const displayedBoxes = draftBox ? [...currentDraft.bboxs, draftBox] : currentDraft.bboxs;

  const workspaceColumns = `${leftOpen ? "288px " : ""}minmax(0, 1fr)${rightOpen ? " 420px" : ""}`;
  const stageStateClass = panning ? "panning" : spaceDown ? "panReady" : "";

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
          <input
            ref={importInputRef}
            className="srOnly"
            type="file"
            accept="application/json,.json"
            onChange={handleImportInput}
          />
          <button className="button secondary" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} aria-hidden="true" />
            이미지/PDF 업로드
          </button>
          <button className="button secondary" type="button" onClick={() => importInputRef.current?.click()}>
            <FolderOpen size={18} aria-hidden="true" />
            JSON 불러오기
          </button>
          <button className="button primary" type="button" onClick={downloadDataset} disabled={!canDownload}>
            <Download size={18} aria-hidden="true" />
            JSON 다운로드
          </button>
          <button
            className="button danger"
            type="button"
            onClick={confirmResetAll}
            disabled={images.length === 0 && records.length === 0}
          >
            <RotateCcw size={18} aria-hidden="true" />
            전체 초기화
          </button>
        </div>
      </header>

      {error ? <div className="errorBar">{error}</div> : null}
      {notice ? (
        <div className="noticeBar">
          <span>{notice}</span>
          <button className="noticeClose" type="button" onClick={() => setNotice(null)} aria-label="닫기">
            ×
          </button>
        </div>
      ) : null}

      <main className="workspace" style={{ gridTemplateColumns: workspaceColumns }}>
        {leftOpen ? (
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
                  const isActive = image.id === activeImageId;
                  const imageRecordCount = records.filter((record) => record.image.id === image.id).length;

                  return (
                    <div className={`imageItem ${isActive ? "selected" : ""}`} key={image.id}>
                      <button className="imageMain" type="button" onClick={() => activateImage(image.id)}>
                        <img src={image.dataUrl} alt="" />
                        <span>
                          <strong>{image.name}</strong>
                          <small>
                            {image.width}x{image.height} · {formatBytes(image.size)} · 묶음 {imageRecordCount}개
                          </small>
                        </span>
                      </button>
                      <button
                        className="iconButton danger"
                        type="button"
                        title="이미지 삭제"
                        onClick={() => deleteImage(image.id)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
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
                    const preview = record.description || "";
                    const isEditingThis = record.id === currentDraft.editingRecordId;

                    return (
                      <div className={`recordItem ${isEditingThis ? "editing" : ""}`} key={record.id}>
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
        ) : null}

        <section className="stagePanel" aria-label="라벨링 작업 영역">
          <div className="stageToolbar">
            <div className="toolbarLeft">
              <button
                className="iconButton"
                type="button"
                title={leftOpen ? "이미지 목록 접기" : "이미지 목록 펼치기"}
                onClick={() => setLeftOpen((open) => !open)}
              >
                {leftOpen ? (
                  <PanelLeftClose size={18} aria-hidden="true" />
                ) : (
                  <PanelLeftOpen size={18} aria-hidden="true" />
                )}
              </button>
              <div className="stageTitle">
                <h2>{activeImage ? activeImage.name : "이미지 없음"}</h2>
                <span>
                  현재 bbox {currentDraft.bboxs.length}개 · 이 이미지 묶음 {activeImageRecords.length}개
                  {spaceDown ? " · 패닝 모드" : ""}
                </span>
              </div>
            </div>

            <div className="toolButtons">
              <div className="zoomControls">
                <button
                  className="iconButton"
                  type="button"
                  title="축소"
                  onClick={() => zoomByButton(1 / 1.25)}
                  disabled={!activeImage || zoom <= ZOOM_MIN}
                >
                  <ZoomOut size={18} aria-hidden="true" />
                </button>
                <button
                  className="zoomLabel"
                  type="button"
                  title="화면에 맞추기"
                  onClick={resetView}
                  disabled={!activeImage}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="iconButton"
                  type="button"
                  title="확대"
                  onClick={() => zoomByButton(1.25)}
                  disabled={!activeImage || zoom >= ZOOM_MAX}
                >
                  <ZoomIn size={18} aria-hidden="true" />
                </button>
                <button
                  className="iconButton"
                  type="button"
                  title="화면에 맞추기"
                  onClick={resetView}
                  disabled={!activeImage}
                >
                  <Maximize size={18} aria-hidden="true" />
                </button>
              </div>
              <button
                className="iconButton"
                type="button"
                title="마지막 bbox 취소"
                onClick={undoLastBBox}
                disabled={currentDraft.bboxs.length === 0}
              >
                <Undo2 size={18} aria-hidden="true" />
              </button>
              <button
                className="iconButton"
                type="button"
                title={rightOpen ? "묶음 편집 접기" : "묶음 편집 펼치기"}
                onClick={() => setRightOpen((open) => !open)}
              >
                {rightOpen ? (
                  <PanelRightClose size={18} aria-hidden="true" />
                ) : (
                  <PanelRightOpen size={18} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            className={`stageViewport ${stageStateClass}`}
            onPointerDown={handleViewportPointerDown}
            onPointerMove={handleViewportPointerMove}
            onPointerUp={handleViewportPointerUp}
            onPointerCancel={handleViewportPointerUp}
          >
            {activeImage && baseFit ? (
              <div
                ref={canvasRef}
                className="stageCanvas"
                style={{
                  width: `${baseFit.w * zoom}px`,
                  height: `${baseFit.h * zoom}px`,
                }}
              >
                <div className="imageShell">
                  <img className="targetImage" src={activeImage.dataUrl} alt={activeImage.name} draggable={false} />
                  <div
                    ref={annotationLayerRef}
                    className="annotationLayer"
                    onPointerDown={handleLayerPointerDown}
                    onPointerMove={handleLayerPointerMove}
                    onPointerUp={handleLayerPointerUp}
                    onPointerCancel={handleLayerPointerUp}
                  >
                    {displayedBoxes.map((box, index) => {
                      const isDraft = box.id === "draft";
                      const isSelected = !isDraft && box.id === selectedBoxId;

                      return (
                        <div
                          className={`bbox ${isDraft ? "draft" : ""} ${isSelected ? "selected" : ""}`}
                          key={`${box.id}-${index}`}
                          data-box-id={isDraft ? undefined : box.id}
                          style={{
                            left: `${box.x * 100}%`,
                            top: `${box.y * 100}%`,
                            width: `${box.width * 100}%`,
                            height: `${box.height * 100}%`,
                          }}
                        >
                          <span data-box-id={isDraft ? undefined : box.id}>{isDraft ? "new" : index + 1}</span>
                          {isSelected && !spaceDown
                            ? HANDLES.map((handle) => (
                                <span
                                  key={handle.dir}
                                  className="handle"
                                  data-handle={handle.dir}
                                  data-box-id={box.id}
                                  style={{
                                    left: `${handle.left}%`,
                                    top: `${handle.top}%`,
                                    cursor: handle.cursor,
                                    transform: "translate(-50%, -50%)",
                                  }}
                                />
                              ))
                            : null}
                        </div>
                      );
                    })}
                  </div>
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

        {rightOpen ? (
          <aside className="detailsPanel" aria-label="묶음 편집">
            <div className="panelHeader">
              <h2>묶음 편집</h2>
              <span className={isEditing ? "editPill" : canCommit ? "readyPill" : "countPill"}>
                {isEditing ? "수정 중" : canCommit ? "준비됨" : "작성 중"}
              </span>
            </div>

            <label className="field description">
              <span>Description</span>
              <textarea
                value={currentDraft.description}
                placeholder={activeImage ? "설명 입력" : "이미지를 먼저 선택하세요"}
                onChange={(event) =>
                  updateCurrentDraft((draft) => ({ ...draft, description: event.target.value }))
                }
                disabled={!activeImage}
              />
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
              <button className="button primary full" type="button" onClick={commitCurrentDraft} disabled={!canCommit}>
                {isEditing ? <Save size={18} aria-hidden="true" /> : <ListPlus size={18} aria-hidden="true" />}
                {isEditing ? "묶음 수정" : "묶음 추가"}
              </button>
            </div>
            {activeImage && !canCommit && (hasDescription || hasBBox) ? (
              <small className="formHint">설명(description)과 bbox가 모두 있어야 묶음을 저장할 수 있습니다.</small>
            ) : null}

            <div className="bboxListHeader">
              <h2>BBox</h2>
              <span>{currentDraft.bboxs.length}</span>
            </div>

            <div className="bboxList">
              {currentDraft.bboxs.length === 0 ? (
                <div className="mutedLine">bbox 없음 · 도면 위에서 드래그해 그리세요</div>
              ) : (
                currentDraft.bboxs.map((box, index) => {
                  const pixel = activeImage ? toPixelBox(box, activeImage) : null;

                  return (
                    <div
                      className={`bboxRow ${box.id === selectedBoxId ? "selected" : ""}`}
                      key={box.id}
                      onClick={() => setSelectedBoxId(box.id)}
                    >
                      <div>
                        <strong>#{index + 1}</strong>
                        <small>
                          {pixel
                            ? `${pixel.x}, ${pixel.y}, ${pixel.width}x${pixel.height}`
                            : `${(box.x * 100).toFixed(1)}%, ${(box.y * 100).toFixed(1)}%`}
                        </small>
                      </div>
                      <button
                        className="iconButton danger"
                        type="button"
                        title="bbox 삭제"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeBBox(box.id);
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        ) : null}
      </main>

      {confirmState ? (
        <div
          className="modalOverlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmState(null);
          }}
        >
          <div className="modalCard" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
            <h2 id="confirmTitle">{confirmState.title}</h2>
            <p>{confirmState.message}</p>
            <div className="modalActions">
              <button className="button secondary" type="button" onClick={() => setConfirmState(null)}>
                취소
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  const action = confirmState.onConfirm;
                  setConfirmState(null);
                  action();
                }}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
