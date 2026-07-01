import { ChangeEvent, PointerEvent, useMemo, useRef, useState } from "react";
import {
  Download,
  ImagePlus,
  ListPlus,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
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
};

type DatasetRecord = {
  id: string;
  image: ImageAsset;
  bboxs: ExportBBox[];
  question: string;
  answer: string;
  createdAt: string;
};

type ExportRecord = Omit<DatasetRecord, "image"> & {
  image: ExportImage;
};

const EMPTY_DRAFT: DraftState = {
  bboxs: [],
  question: "",
  answer: "",
};

const MIN_BOX_SIZE = 0.006;

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

function App() {
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<NormalizedBBox | null>(null);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);

  const activeImage = images.find((image) => image.id === activeImageId) ?? null;
  const currentDraft = activeImageId ? drafts[activeImageId] ?? EMPTY_DRAFT : EMPTY_DRAFT;

  const activeImageRecords = useMemo(
    () => records.filter((record) => record.image.id === activeImageId),
    [activeImageId, records],
  );

  const canCommitCurrent =
    Boolean(activeImage) &&
    currentDraft.bboxs.length > 0 &&
    currentDraft.question.trim().length > 0 &&
    currentDraft.answer.trim().length > 0;
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

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    setIsLoadingImages(true);
    setError(null);

    try {
      const loadedImages = await Promise.all(files.map(readImageFile));

      setImages((previous) => [...previous, ...loadedImages]);
      setDrafts((previous) => {
        const next = { ...previous };
        loadedImages.forEach((image) => {
          next[image.id] = { ...EMPTY_DRAFT, bboxs: [] };
        });
        return next;
      });
      setActiveImageId((previous) => previous ?? loadedImages[0].id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "이미지를 불러오지 못했습니다.");
    } finally {
      setIsLoadingImages(false);
      event.target.value = "";
    }
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
      id: createId("record"),
      image: activeImage,
      bboxs: currentDraft.bboxs.map((box, index) => buildExportBox(box, activeImage, index)),
      question: currentDraft.question.trim(),
      answer: currentDraft.answer.trim(),
      createdAt: new Date().toISOString(),
    };
  }

  function addCurrentRecord() {
    const record = buildCurrentRecord();
    if (!record) return;

    setRecords((previous) => [record, ...previous]);
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
      },
    }));
    setDraftBox(null);
    setDragStart(null);
  }

  function downloadDataset() {
    const pendingRecord = buildCurrentRecord();
    const exportRecords = pendingRecord ? [pendingRecord, ...records] : records;
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
            accept="image/*"
            multiple
            onChange={handleFileInput}
          />
          <button className="button secondary" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} aria-hidden="true" />
            이미지 업로드
          </button>
          <button className="button primary" type="button" onClick={downloadDataset} disabled={!canDownload}>
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
              title="이미지 추가"
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
                {isLoadingImages ? "불러오는 중" : "이미지 업로드"}
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
                records.map((record, index) => (
                  <div className="recordItem" key={record.id}>
                    <button className="recordMain" type="button" onClick={() => loadRecordAsDraft(record)}>
                      <strong>#{records.length - index}</strong>
                      <span>{record.image.name}</span>
                      <small>
                        bbox {record.bboxs.length}개 · Q {record.question.slice(0, 22)}
                        {record.question.length > 22 ? "..." : ""}
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
                ))
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
                disabled={!activeImage || (currentDraft.bboxs.length === 0 && !currentDraft.question && !currentDraft.answer)}
              >
                <RotateCcw size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="stageViewport">
            {activeImage ? (
              <div className="imageShell">
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
                이미지 업로드
              </button>
            )}
          </div>
        </section>

        <aside className="detailsPanel" aria-label="QA 입력">
          <div className="panelHeader">
            <h2>묶음 편집</h2>
            <span className={canCommitCurrent ? "readyPill" : "countPill"}>{canCommitCurrent ? "준비됨" : "작성 중"}</span>
          </div>

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
            <span>Answer</span>
            <textarea
              value={currentDraft.answer}
              placeholder="답변 입력"
              onChange={(event) =>
                updateCurrentDraft((draft) => ({
                  ...draft,
                  answer: event.target.value,
                }))
              }
              disabled={!activeImage}
            />
          </label>

          <div className="formActions">
            <button className="button primary full" type="button" onClick={addCurrentRecord} disabled={!canCommitCurrent}>
              <ListPlus size={18} aria-hidden="true" />
              묶음 추가
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
    </div>
  );
}

export default App;
