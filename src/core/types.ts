export type DocId = string;
export type PdfRect = [number, number, number, number];
export type PenColor = 'amber' | 'teal' | 'pink' | 'blue';

export interface DocMeta {
  id: DocId;
  title: string;
  url?: string;
  pageCount: number;
  pdfjsVersion: string;
  addedAt: number;
  lastOpenedAt: number;
}

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
  captionAnchor: { page: number; start: number; end: number };
  region: { page: number; rect: PdfRect } | null;
  regionSource: 'auto' | 'manual';
  confidence: number;
}

