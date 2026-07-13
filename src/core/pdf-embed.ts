import {
  AFRelationship,
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString
} from 'pdf-lib';
import { sha256Hex } from './doc-identity';
import { makeUuid } from './store';
import type {
  AnnotationBucket,
  FigureEntry,
  Highlight,
  MarginAttachmentV1,
  Memo,
  PortableAnnotationPayload
} from './types';

export const MARGIN_ATTACHMENT_NAME = 'margin.annotations.v1.json';
export const MARGIN_ATTACHMENT_MIME = 'application/vnd.margin.annotations+json';
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_ITEMS = 50_000;
export const MAX_ATTACHMENT_STRING_LENGTH = 1024 * 1024;

export class InvalidMarginAttachmentError extends Error {
  constructor(message = 'Margin 메모 데이터 형식이 올바르지 않습니다.') {
    super(message);
    this.name = 'InvalidMarginAttachmentError';
  }
}

export class MarginAttachmentTooLargeError extends InvalidMarginAttachmentError {
  constructor() {
    super('Margin 메모 데이터가 지원 크기(5 MiB)를 넘습니다.');
    this.name = 'MarginAttachmentTooLargeError';
  }
}

export class UnsupportedMarginAttachmentVersionError extends Error {
  constructor(readonly version: number) {
    super('이 파일의 메모를 읽으려면 Margin 업데이트가 필요합니다.');
    this.name = 'UnsupportedMarginAttachmentVersionError';
  }
}

export interface EmbedMarginOptions {
  pageCount: number;
  artifactId?: string;
  exportedAt?: number;
}

export interface EmbedMarginResult {
  bytes: Uint8Array;
  attachment: MarginAttachmentV1;
  signed: boolean;
}

export interface ReadMarginResult {
  attachment: MarginAttachmentV1 | null;
  signed: boolean;
}

export async function embedMarginAttachment(
  sourceBytes: Uint8Array,
  bucket: AnnotationBucket,
  options: EmbedMarginOptions
): Promise<EmbedMarginResult> {
  const pdf = await PDFDocument.load(copyBytes(sourceBytes), { updateMetadata: false });
  const signed = documentHasSignature(pdf);
  const attachment: MarginAttachmentV1 = {
    format: 'margin.annotations',
    version: 1,
    artifactId: options.artifactId ?? makeUuid(),
    exportedAt: options.exportedAt ?? Date.now(),
    source: {
      sha256: await sha256Hex(sourceBytes),
      pageCount: options.pageCount
    },
    payload: portablePayload(bucket)
  };
  validateMarginAttachment(attachment);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(attachment));
  if (jsonBytes.byteLength > MAX_ATTACHMENT_BYTES) throw new MarginAttachmentTooLargeError();

  removeMarginAttachments(pdf);
  await pdf.attach(jsonBytes, MARGIN_ATTACHMENT_NAME, {
    mimeType: MARGIN_ATTACHMENT_MIME,
    description: 'Margin annotations',
    afRelationship: AFRelationship.Data
  });
  return {
    bytes: await pdf.save({ useObjectStreams: false, updateFieldAppearances: false }),
    attachment,
    signed
  };
}

export async function readMarginAttachment(sourceBytes: Uint8Array): Promise<ReadMarginResult> {
  const pdf = await PDFDocument.load(copyBytes(sourceBytes), { updateMetadata: false });
  const entries = marginAttachmentEntries(pdf);
  if (!entries.length) return { attachment: null, signed: documentHasSignature(pdf) };

  // 재export는 하나만 남겨야 한다. 손상 파일에 여러 개가 있으면 마지막 이름 항목을 최신으로 본다.
  const bytes = entries.at(-1)!.bytes;
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new MarginAttachmentTooLargeError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidMarginAttachmentError();
  }
  const version = record(parsed)?.version;
  if (typeof version === 'number' && version > 1) {
    throw new UnsupportedMarginAttachmentVersionError(version);
  }
  validateMarginAttachment(parsed);
  return { attachment: parsed, signed: documentHasSignature(pdf) };
}

export async function hasPdfSignature(sourceBytes: Uint8Array): Promise<boolean> {
  const pdf = await PDFDocument.load(copyBytes(sourceBytes), { updateMetadata: false });
  return documentHasSignature(pdf);
}

export async function countMarginAttachments(sourceBytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(copyBytes(sourceBytes), { updateMetadata: false });
  return marginAttachmentEntries(pdf).length;
}

export function portablePayload(bucket: AnnotationBucket): PortableAnnotationPayload {
  return {
    highlights: bucket.highlights.map(({ doc: _doc, ...item }) => structuredClone(item)),
    memos: bucket.memos.map(({ doc: _doc, ...item }) => structuredClone(item)),
    figures: bucket.figures.map(({ doc: _doc, ...item }) => structuredClone(item))
  };
}

export function validateMarginAttachment(value: unknown): asserts value is MarginAttachmentV1 {
  const root = record(value);
  if (!root || root.format !== 'margin.annotations') throw new InvalidMarginAttachmentError();
  if (root.version !== 1) {
    if (typeof root.version === 'number' && root.version > 1) {
      throw new UnsupportedMarginAttachmentVersionError(root.version);
    }
    throw new InvalidMarginAttachmentError();
  }
  if (!nonEmptyString(root.artifactId) || !finiteNumber(root.exportedAt)) {
    throw new InvalidMarginAttachmentError();
  }
  const source = record(root.source);
  if (!source || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256)
    || !positiveInteger(source.pageCount)) {
    throw new InvalidMarginAttachmentError();
  }
  const payload = record(root.payload);
  if (!payload || !Array.isArray(payload.highlights) || !Array.isArray(payload.memos)
    || !Array.isArray(payload.figures)) {
    throw new InvalidMarginAttachmentError();
  }
  if (payload.highlights.length + payload.memos.length + payload.figures.length > MAX_ATTACHMENT_ITEMS) {
    throw new InvalidMarginAttachmentError('Margin 메모 항목 수가 지원 한도를 넘습니다.');
  }
  validateStringLengths(root);
  for (const item of payload.highlights) validateHighlight(item, source.pageCount as number);
  for (const item of payload.memos) validateMemo(item, source.pageCount as number);
  for (const item of payload.figures) validateFigure(item, source.pageCount as number);
}

function validateHighlight(value: unknown, pageCount: number): asserts value is Omit<Highlight, 'doc'> {
  const item = record(value);
  const anchor = record(item?.anchor);
  if (!item || !nonEmptyString(item.id)
    || !['amber', 'teal', 'pink', 'blue'].includes(String(item.color))
    || !finiteNumber(item.createdAt)
    || (item.memoId !== undefined && typeof item.memoId !== 'string')
    || !anchor || !validPage(anchor.page, pageCount)
    || !nonNegativeInteger(anchor.start) || !nonNegativeInteger(anchor.end)
    || (anchor.end as number) < (anchor.start as number)
    || typeof anchor.quote !== 'string' || typeof anchor.prefix !== 'string' || typeof anchor.suffix !== 'string'
    || !Array.isArray(anchor.quads)
    || !anchor.quads.every((quad) => Array.isArray(quad) && quad.length === 4 && quad.every(finiteNumber))) {
    throw new InvalidMarginAttachmentError();
  }
}

function validateMemo(value: unknown, pageCount: number): asserts value is Omit<Memo, 'doc'> {
  const item = record(value);
  if (!item || !nonEmptyString(item.id)
    || !['highlight', 'figure'].includes(String(item.anchorType))
    || !nonEmptyString(item.anchorId) || typeof item.quote !== 'string'
    || !validPage(item.page, pageCount) || typeof item.text !== 'string'
    || !Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === 'string')
    || !Array.isArray(item.links) || !item.links.every((link) => typeof link === 'string')
    || !finiteNumber(item.createdAt) || !finiteNumber(item.updatedAt)) {
    throw new InvalidMarginAttachmentError();
  }
}

function validateFigure(value: unknown, pageCount: number): asserts value is Omit<FigureEntry, 'doc'> {
  const item = record(value);
  const captionAnchor = item?.captionAnchor === undefined ? undefined : record(item.captionAnchor);
  const region = item?.region === null ? null : record(item?.region);
  if (!item || !nonEmptyString(item.id)
    || !['figure', 'table'].includes(String(item.kind))
    || typeof item.num !== 'string' || typeof item.label !== 'string'
    || !validPage(item.page, pageCount) || typeof item.captionText !== 'string'
    || !['auto', 'manual'].includes(String(item.regionSource)) || !finiteNumber(item.confidence)
    || (captionAnchor !== undefined && (!captionAnchor || !validPage(captionAnchor.page, pageCount)
      || !nonNegativeInteger(captionAnchor.start) || !nonNegativeInteger(captionAnchor.end)))
    || (region !== null && (!region || !validPage(region.page, pageCount)
      || !Array.isArray(region.rect) || region.rect.length !== 4 || !region.rect.every(finiteNumber)))) {
    throw new InvalidMarginAttachmentError();
  }
}

function validateStringLengths(value: unknown): void {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (new TextEncoder().encode(current).byteLength > MAX_ATTACHMENT_STRING_LENGTH) {
        throw new InvalidMarginAttachmentError();
      }
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === 'object') {
      stack.push(...Object.values(current));
    }
  }
}

function marginAttachmentEntries(pdf: PDFDocument): Array<{ ref: PDFRef | null; bytes: Uint8Array }> {
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embedded = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!embedded) return [];
  const pairs = namedFilePairs(embedded);
  const entries: Array<{ ref: PDFRef | null; bytes: Uint8Array }> = [];
  for (const pair of pairs) {
    if (pair.name !== MARGIN_ATTACHMENT_NAME) continue;
    const ef = pair.fileSpec.lookupMaybe(PDFName.of('EF'), PDFDict);
    const stream = ef?.lookupMaybe(PDFName.of('F'), PDFStream);
    if (!(stream instanceof PDFRawStream)) throw new InvalidMarginAttachmentError();
    const mime = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (mime !== MARGIN_ATTACHMENT_MIME) throw new InvalidMarginAttachmentError();
    entries.push({ ref: pair.ref, bytes: decodePDFRawStream(stream).decode() });
  }
  return entries;
}

function removeMarginAttachments(pdf: PDFDocument): void {
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embedded = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  if (!embedded) return;
  const removedRefs: string[] = [];
  removeNamedFiles(embedded, MARGIN_ATTACHMENT_NAME, removedRefs);
  const associated = pdf.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (!associated || !removedRefs.length) return;
  for (let index = associated.size() - 1; index >= 0; index -= 1) {
    const raw = associated.get(index);
    if (raw instanceof PDFRef && removedRefs.includes(raw.toString())) associated.remove(index);
  }
}

function removeNamedFiles(dict: PDFDict, target: string, removedRefs: string[]): void {
  const names = dict.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let index = names.size() - 2; index >= 0; index -= 2) {
      const name = names.lookupMaybe(index, PDFString, PDFHexString)?.decodeText();
      if (name !== target) continue;
      const ref = names.get(index + 1);
      if (ref instanceof PDFRef) removedRefs.push(ref.toString());
      names.remove(index + 1);
      names.remove(index);
    }
  }
  const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return;
  for (let index = 0; index < kids.size(); index += 1) {
    const child = kids.lookupMaybe(index, PDFDict);
    if (child) removeNamedFiles(child, target, removedRefs);
  }
}

function namedFilePairs(dict: PDFDict): Array<{
  name: string;
  ref: PDFRef | null;
  fileSpec: PDFDict;
}> {
  const pairs: ReturnType<typeof namedFilePairs> = [];
  const names = dict.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      const name = names.lookupMaybe(index, PDFString, PDFHexString)?.decodeText();
      const raw = names.get(index + 1);
      const fileSpec = names.lookupMaybe(index + 1, PDFDict);
      if (name && fileSpec) pairs.push({ name, ref: raw instanceof PDFRef ? raw : null, fileSpec });
    }
  }
  const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let index = 0; index < kids.size(); index += 1) {
      const child = kids.lookupMaybe(index, PDFDict);
      if (child) pairs.push(...namedFilePairs(child));
    }
  }
  return pairs;
}

function documentHasSignature(pdf: PDFDocument): boolean {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const fieldType = object.lookupMaybe(PDFName.of('FT'), PDFName)?.decodeText();
    const type = object.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText();
    if (fieldType === 'Sig' || type === 'Sig' || object.has(PDFName.of('ByteRange'))) return true;
  }
  return false;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validPage(value: unknown, pageCount: number): value is number {
  return positiveInteger(value) && Number(value) <= pageCount;
}
