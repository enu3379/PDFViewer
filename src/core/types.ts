export type DocId = string;
export type BucketId = string;
export type PdfRect = [number, number, number, number];
export type PenColor = 'amber' | 'teal' | 'pink' | 'blue';
export type SyncState = 'syncing' | 'undecided' | 'detached';

export type DocLocator =
  | { kind: 'path' | 'url'; value: string }
  | { kind: 'fsa-handle'; handleKey: string };

export interface ContentEvidence {
  pdfJsId: string;
  sha256?: string;
  byteLength?: number;
  fileName?: string;
  lastModified?: number;
}

export interface DocNode {
  id: DocId;
  syncHubId: DocId | null;
  syncState: SyncState;
  bucketId: BucketId;
  locator: DocLocator | null;
  artifactId?: string;
  contentEvidence: ContentEvidence;
  forkBaseRevisionId?: string;
  syncHubBaselineRevisionId?: string;
  title: string;
  pageCount: number;
  pdfjsVersion: string;
  addedAt: number;
  lastOpenedAt: number;
  lastEditedAt: number;
  hintShownAt?: number;
}

/** @deprecated v2 문서 메타데이터의 정식 이름은 DocNode다. */
export type DocMeta = DocNode;

export interface Anchor {
  page: number;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  quads: PdfRect[];
}

export interface Highlight {
  id: string;
  doc: DocId;
  color: PenColor;
  anchor: Anchor;
  memoId?: string;
  createdAt: number;
}

export interface Memo {
  id: string;
  doc: DocId;
  anchorType: 'highlight' | 'figure';
  anchorId: string;
  quote: string;
  page: number;
  text: string;
  tags: string[];
  links: string[];
  createdAt: number;
  updatedAt: number;
}

export interface FigureEntry {
  id: string;
  doc: DocId;
  kind: 'figure' | 'table';
  num: string;
  label: string;
  page: number;
  captionText: string;
  captionAnchor?: { page: number; start: number; end: number };
  region: { page: number; rect: PdfRect } | null;
  regionSource: 'auto' | 'manual';
  confidence: number;
}

export interface AnnotationBucket {
  id: BucketId;
  revisionId: string;
  highlights: Highlight[];
  memos: Memo[];
  figures: FigureEntry[];
}

export type PortableHighlight = Omit<Highlight, 'doc'>;
export type PortableMemo = Omit<Memo, 'doc'>;
export type PortableFigureEntry = Omit<FigureEntry, 'doc'>;

export interface PortableAnnotationPayload {
  highlights: PortableHighlight[];
  memos: PortableMemo[];
  figures: PortableFigureEntry[];
}

export interface MarginAttachmentV1 {
  format: 'margin.annotations';
  version: 1;
  artifactId: string;
  exportedAt: number;
  source: {
    sha256: string;
    pageCount: number;
  };
  payload: PortableAnnotationPayload;
}

export interface DownloadBinding {
  id: string;
  nodeId: DocId;
  kind?: 'file-only' | 'memo-with' | 'clone';
  chromeDownloadId?: number;
  finalPath?: string;
  expectedSha256: string;
  status: 'pending' | 'complete' | 'interrupted';
  createdAt: number;
  completedAt?: number;
}

export type LocatorIndex = Record<string, DocId>;

export interface IdentityState {
  nodes: Record<DocId, DocNode>;
  buckets: Record<BucketId, AnnotationBucket>;
  locators: LocatorIndex;
  downloadBindings: DownloadBinding[];
}
