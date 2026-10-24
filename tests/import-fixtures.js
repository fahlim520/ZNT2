const { createCanvas } = require('@napi-rs/canvas');
const JSZip = require('jszip');
function pdf(objects) {
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0]; let length = parts[0].length;
  objects.forEach((object, index) => { offsets.push(length); const b = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')]); parts.push(b); length += b.length; });
  const xref = length;
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}
function textPdf() {
  const stream = 'BT /F1 16 Tf 30 750 Td (Campus deadline 2026-10-26 15:05 Submit application materials.) Tj ET';
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
}
function imageCanvas() { const c = createCanvas(1000, 220), x = c.getContext('2d'); x.fillStyle = 'white'; x.fillRect(0, 0, 1000, 220); x.fillStyle = 'black'; x.font = '32px Microsoft YaHei'; x.fillText('校园通知：2026年10月26日15:05提交报名材料', 20, 75); x.fillText('地点：学生事务中心', 20, 150); return c; }
function scanPdf(c) {
  const jpg = c.toBuffer('image/jpeg');
  const stream = 'q 1000 0 0 220 0 0 cm /Im0 Do Q';
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 220] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>', Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1000 /Height 220 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
}
async function docx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>校园通知：2026年10月26日15:05提交报名材料。</w:t></w:r></w:p><w:p><w:r><w:t>地点：学生事务中心。</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}


module.exports = { textPdf, scanPdf, imageCanvas, docx };
