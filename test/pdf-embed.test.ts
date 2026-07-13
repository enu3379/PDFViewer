import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  countMarginAttachments,
  embedMarginAttachment,
  hasPdfSignature,
  MAX_ATTACHMENT_STRING_LENGTH,
  MARGIN_ATTACHMENT_MIME,
  MARGIN_ATTACHMENT_NAME,
  MarginAttachmentTooLargeError,
  readMarginAttachment,
  UnsupportedMarginAttachmentVersionError
} from '../src/core/pdf-embed';
import type { AnnotationBucket } from '../src/core/types';

async function blankPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  return pdf.save();
}

function sampleBucket(): AnnotationBucket {
  return {
    id: 'bucket',
    revisionId: 'rev',
    highlights: [{
      id: 'h1', doc: 'node', color: 'amber', createdAt: 1,
      anchor: { page: 1, start: 0, end: 5, quote: 'hello', prefix: '', suffix: '', quads: [[1, 2, 3, 4]] }
    }],
    memos: [{
      id: 'm1', doc: 'node', anchorType: 'highlight', anchorId: 'h1', quote: 'hello', page: 1,
      text: 'memo', tags: ['tag'], links: ['link'], createdAt: 1, updatedAt: 2
    }],
    figures: [{
      id: 'f1', doc: 'node', kind: 'figure', num: '1', label: 'Figure 1', page: 1,
      captionText: 'caption', region: { page: 1, rect: [1, 2, 3, 4] },
      regionSource: 'manual', confidence: 1
    }]
  };
}

describe('Margin PDF attachment', () => {
  it('round-trips highlights, memos, and figures without local node ids', async () => {
    const source = await blankPdf();
    const embedded = await embedMarginAttachment(source, sampleBucket(), {
      pageCount: 1,
      artifactId: 'artifact-1',
      exportedAt: 10
    });
    const read = await readMarginAttachment(embedded.bytes);

    expect(read.attachment).toEqual(embedded.attachment);
    expect(read.attachment?.payload.highlights[0]).not.toHaveProperty('doc');
    expect(read.attachment?.payload.memos[0].text).toBe('memo');
    expect(embedded.attachment.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replaces the previous Margin attachment and issues a new artifact id', async () => {
    const first = await embedMarginAttachment(await blankPdf(), sampleBucket(), { pageCount: 1 });
    const second = await embedMarginAttachment(first.bytes, sampleBucket(), { pageCount: 1 });

    expect(second.attachment.artifactId).not.toBe(first.attachment.artifactId);
    expect(await countMarginAttachments(second.bytes)).toBe(1);
    expect((await readMarginAttachment(second.bytes)).attachment?.artifactId)
      .toBe(second.attachment.artifactId);
  });

  it('rejects oversized strings before writing', async () => {
    const data = sampleBucket();
    data.memos[0].text = 'x'.repeat(MAX_ATTACHMENT_STRING_LENGTH + 1);
    await expect(embedMarginAttachment(await blankPdf(), data, { pageCount: 1 }))
      .rejects.toHaveProperty('name', 'InvalidMarginAttachmentError');
  });

  it('reports unsupported future versions as an update requirement', async () => {
    const source = await blankPdf();
    const pdf = await PDFDocument.load(source);
    const future = {
      format: 'margin.annotations', version: 2, artifactId: 'future', exportedAt: 1,
      source: { sha256: 'a'.repeat(64), pageCount: 1 },
      payload: { highlights: [], memos: [], figures: [] }
    };
    await pdf.attach(new TextEncoder().encode(JSON.stringify(future)), MARGIN_ATTACHMENT_NAME, {
      mimeType: MARGIN_ATTACHMENT_MIME
    });

    await expect(readMarginAttachment(await pdf.save())).rejects.toBeInstanceOf(
      UnsupportedMarginAttachmentVersionError
    );
  });

  it('rejects a lookalike attachment with the wrong MIME type', async () => {
    const pdf = await PDFDocument.load(await blankPdf());
    const attachment = {
      format: 'margin.annotations', version: 1, artifactId: 'wrong-mime', exportedAt: 1,
      source: { sha256: 'a'.repeat(64), pageCount: 1 },
      payload: { highlights: [], memos: [], figures: [] }
    };
    await pdf.attach(new TextEncoder().encode(JSON.stringify(attachment)), MARGIN_ATTACHMENT_NAME, {
      mimeType: 'application/json'
    });

    await expect(readMarginAttachment(await pdf.save()))
      .rejects.toHaveProperty('name', 'InvalidMarginAttachmentError');
  });

  it('rejects attachments over 5 MiB', async () => {
    const source = await blankPdf();
    const pdf = await PDFDocument.load(source);
    await pdf.attach(new Uint8Array(5 * 1024 * 1024 + 1), MARGIN_ATTACHMENT_NAME, {
      mimeType: MARGIN_ATTACHMENT_MIME
    });
    await expect(readMarginAttachment(await pdf.save())).rejects.toBeInstanceOf(
      MarginAttachmentTooLargeError
    );
  });

  it('detects signature fields so the UI can warn before saving', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const signature = pdf.context.obj({ FT: 'Sig', T: 'Signature1' });
    const signatureRef = pdf.context.register(signature);
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [signatureRef] }));
    expect(await hasPdfSignature(await pdf.save())).toBe(true);
  });
});
