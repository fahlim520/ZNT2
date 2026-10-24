import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { IMPORT_EXTENSIONS, IMPORT_LIMITS, type ImportedDocument } from './import-domain';

// PDF.js is loaded outside ASAR because Node's ESM loader needs real files.
// Resolve canvas there too: loading its native binding through both archive
// paths would create incompatible Image/Canvas instances for scanned PDFs.
const canvasEntry = require.resolve('@napi-rs/canvas').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const { createCanvas, loadImage, DOMMatrix, Path2D, ImageData } = require(canvasEntry) as typeof import('@napi-rs/canvas');

const importModule = new Function('name', 'return import(name)') as (name: string) => Promise<any>;
let pdfModule: Promise<any> | undefined;
function pdfBase() { return path.dirname(require.resolve('pdfjs-dist/package.json')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
function pdfjs() {
  Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
  return pdfModule ??= (async () => {
    // PDF.js 4 treats every Electron process except "browser" as a DOM
    // renderer. Utility processes are Node-only; let both PDF.js modules
    // select their Node factories, then restore Electron's process metadata.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'type');
    const utility = process.versions.electron && process.type === 'utility';
    try {
      if (utility) Object.defineProperty(process, 'type', { ...descriptor, value: 'browser' });
      const base = path.join(pdfBase(), 'legacy/build');
      const pdf = await importModule(pathToFileURL(path.join(base, 'pdf.mjs')).href);
      await importModule(pathToFileURL(path.join(base, 'pdf.worker.mjs')).href);
      return pdf;
    } finally {
      if (utility && descriptor) Object.defineProperty(process, 'type', descriptor);
    }
  })();
}
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new Error('已取消导入'); }

export async function ocrImage(buffer: Buffer, resourceDirectory: string, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') throw new Error('截图识别需要 Windows 10/11 的本地 OCR 功能');
  cancelled(signal);
  const image = await loadImage(buffer);
  if (image.width * image.height > 80_000_000) throw new Error('图片像素过大，请缩小后重试');
  const width = Math.min(2400, image.width);
  const ratio = width / image.width;
  const height = Math.ceil(image.height * ratio);
  const count = Math.ceil(height / 2250);
  if (count > 12) throw new Error('截图过长，请分成多张图片再导入');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qing-task-ocr-'));
  const texts: string[] = [];
  try {
    for (let index = 0; index < count; index++) {
      cancelled(signal);
      const top = Math.max(0, index * 2250 - (index ? 80 : 0));
      const tileHeight = Math.min(2400, height - top);
      const canvas = createCanvas(width, tileHeight);
      const context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, width, tileHeight);
      context.drawImage(image, 0, -top, width, height);
      const filename = path.join(directory, `${index}.png`);
      await fs.writeFile(filename, canvas.toBuffer('image/png'));
      const result = await new Promise<string>((resolve, reject) => {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(resourceDirectory, 'ocr.ps1'), '-ImagePath', filename], { windowsHide: true, timeout: 35_000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout, stderr) => {
          if (error) {
            if (/language pack|language settings/i.test(stderr)) reject(new Error('本机未安装 OCR 语言包，请在 Windows 语言设置中安装中文或英文的“光学字符识别”组件'));
            else reject(new Error(signal?.aborted ? '已取消导入' : error.killed ? '图片识别超时，请裁剪图片后重试' : 'Windows 文字识别失败，请检查系统 OCR 语言组件，或改为导入文字版文件'));
          } else {
            try { resolve(JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')).text || ''); }
            catch { reject(new Error('Windows 文字识别返回格式异常')); }
          }
        });
      });
      texts.push(result);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
  return texts.join('\n');
}

async function checkDocx(buffer: Buffer): Promise<void> {
  const yauzl = require('yauzl');
  await new Promise<void>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true }, (error: Error | null, zip: any) => {
    if (error) { reject(new Error('Word 文件损坏、已加密或格式不受支持')); return; }
    let bytes = 0, entries = 0;
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry: any) => {
      bytes += entry.uncompressedSize; entries++;
      if (bytes > 100 * 1024 * 1024 || entries > 3000) { zip.close(); reject(new Error('Word 解压后内容过大，请拆分文档')); }
      else zip.readEntry();
    });
    zip.readEntry();
  }));
}

async function extractPdf(buffer: Buffer, warnings: string[], resources: string, progress: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const pdf = await pdfjs();
  const base = pdfBase();
  const loading = pdf.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, disableFontFace: true, cMapUrl: path.join(base, 'cmaps') + path.sep, cMapPacked: true, standardFontDataUrl: path.join(base, 'standard_fonts') + path.sep });
  let document: any;
  try {
    document = await loading.promise;
    const limit = Math.min(document.numPages, IMPORT_LIMITS.pages);
    if (document.numPages > limit) warnings.push(`PDF 共 ${document.numPages} 页，本次仅识别前 ${limit} 页，请拆分其余页面后导入。`);
    const texts: string[] = [];
    let length = 0;
    for (let number = 1; number <= limit; number++) {
      cancelled(signal); progress(`正在识别 PDF 第 ${number}/${limit} 页…`);
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = content.items.map((item: any) => item.str ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      // Scan-only pages have no text layer. PDFs containing both a few text
      // labels and a scanned notice still benefit from OCR.
      if (text.replace(/\s/g, '').length < 35) {
        try {
          const original = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 2300 / Math.max(original.width, original.height));
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext('2d');
          await page.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
          const recognized = await ocrImage(canvas.toBuffer('image/png'), resources, signal);
          if (recognized.trim()) text = recognized;
          warnings.push(`第 ${number} 页使用了 OCR，请核对姓名、数字和日期。`);
        } catch (error) { cancelled(signal); warnings.push(`第 ${number} 页：${error instanceof Error ? error.message : '扫描识别失败'}`); }
      }
      texts.push(`[第 ${number} 页]\n${text || '（本页未识别到文字）'}`); length += text.length;
      page.cleanup();
      if (length > IMPORT_LIMITS.text) { warnings.push('PDF 文字过长，后续页面未读取。'); break; }
    }
    return texts.join('\n\n');
  } catch (error: any) {
    if (error?.name === 'PasswordException') throw new Error('PDF 已加密，请先解除密码后再导入');
    if (error?.name === 'InvalidPDFException') throw new Error('PDF 文件损坏或不是有效 PDF');
    throw error;
  } finally { if (document) await document.destroy(); else await loading.destroy(); }
}

export async function extractFiles(paths: string[], resources: string, progress: (message: string) => void = () => {}, signal?: AbortSignal): Promise<ImportedDocument[]> {
  if (!Array.isArray(paths) || !paths.length || paths.length > IMPORT_LIMITS.files || paths.some(item => typeof item !== 'string' || !path.isAbsolute(item) || item.length > 2000)) throw new Error(`一次请选择 1–${IMPORT_LIMITS.files} 个文件`);
  const documents: ImportedDocument[] = [];
  let remaining = IMPORT_LIMITS.text;
  for (const filename of [...new Set(paths)]) {
    cancelled(signal);
    const document: ImportedDocument = { id: randomUUID(), name: path.basename(filename), text: '', warnings: [] };
    documents.push(document);
    try {
      progress(`正在读取 ${document.name}…`);
      const extension = path.extname(filename).slice(1).toLowerCase();
      if (!IMPORT_EXTENSIONS.includes(extension)) throw new Error('暂不支持此格式，请导出为 PDF、Word、图片或 TXT 后导入');
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new Error('请拖入文件，暂不支持文件夹');
      if (stat.size > IMPORT_LIMITS.fileBytes) throw new Error('文件超过 20 MB，请压缩或拆分后导入');
      if (stat.size === 0) throw new Error('文件内容为空');
      if (remaining <= 0) throw new Error('本批文字已达到 5 万字上限，请单独导入此文件');
      const buffer = await fs.readFile(filename);
      let text: string;
      if (extension === 'pdf') text = await extractPdf(buffer, document.warnings, resources, progress, signal);
      else if (extension === 'docx') {
        await checkDocx(buffer);
        const result = await require('mammoth').extractRawText({ buffer });
        text = result.value;
        document.warnings.push('Word 中的内嵌图片不参与文字提取；图片通知请另存为截图导入。');
      } else if (extension === 'doc') {
        const Extractor = require('word-extractor');
        const result = await new Extractor().extract(buffer);
        text = [result.getBody(), result.getFootnotes(), result.getEndnotes(), result.getHeaders(), result.getTextboxes?.()].filter(Boolean).join('\n');
      } else if (['txt', 'md', 'csv'].includes(extension)) {
        if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString('utf16le');
        else { text = buffer.toString('utf8'); if (text.includes('\ufffd')) { text = new TextDecoder('gb18030').decode(buffer); document.warnings.push('文件按 GB18030 编码读取，请核对文字。'); } }
      } else {
        text = await ocrImage(buffer, resources, signal);
        document.warnings.push('图片使用本地 OCR 识别，请核对姓名、数字和日期。');
      }
      text = text.replace(/\u0000/g, '').trim();
      if (!text || !text.replace(/\[第 \d+ 页\]|（本页未识别到文字）|\s/g, '')) throw new Error('未识别到文字，请换用清晰截图或文字版文件');
      if (text.length > remaining) document.warnings.push(`文字超出本批 5 万字上限，已截断；请分批导入以免遗漏。`);
      document.text = text.slice(0, remaining); remaining -= document.text.length;
    } catch (error: any) {
      cancelled(signal);
      document.error = ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? '无法读取文件，请检查文件是否存在或是否被占用' : error instanceof Error ? error.message : '文件读取失败';
    }
  }
  return documents;
}
