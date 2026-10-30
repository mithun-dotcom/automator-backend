// The signed reseller agreement as a PDF: header, reseller details and agreed
// rates, the full policy text, and the signature block.
const path = require('path');
const PDFDocument = require('pdfkit');
const policy = require('./reseller-policy');

const NAVY = '#211c5c';
const TEXT = '#334155';
const MUTED = '#64748b';

const money = (n) => `$${Number(n).toFixed(2)}`;

/**
 * build({ reseller: { brand, name, company, email, commitment },
 *         prices: [{ label, price }], signer: { name, title }, signedAt: Date,
 *         ip, signature: Buffer (PNG/JPEG) }) -> Promise<Buffer>
 */
function build({ reseller, prices, signer, signedAt, ip, signature }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `${policy.TITLE} – ${reseller.brand || reseller.email}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - 112;

    try {
      doc.image(path.join(__dirname, 'public', 'logo-full.png'), 56, 44, { width: 150 });
    } catch { /* logo is optional */ }
    doc.moveDown(3.2);
    doc.font('Helvetica-Bold').fontSize(17).fillColor(NAVY).text(policy.TITLE);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
      .text(`Agreement version ${policy.VERSION} · Signed ${signedAt.toUTCString()}`);
    doc.moveDown(0.8);

    // Reseller details and the rates in force when they signed.
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Reseller');
    doc.font('Helvetica').fontSize(10).fillColor(TEXT);
    [['Business', reseller.brand || reseller.company || '—'], ['Contact', reseller.name || '—'], ['Email', reseller.email],
      ['Agreed monthly commitment', reseller.commitment ? `${reseller.commitment.toLocaleString('en-US')} inboxes per month` : 'As agreed with Mithmill']]
      .forEach(([k, v]) => doc.text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(v).font('Helvetica'));
    if (prices.length) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('Agreed wholesale rates (per mailbox per month)');
      doc.font('Helvetica').fontSize(10).fillColor(TEXT);
      prices.forEach((p) => doc.text(`• ${p.label}: ${money(p.price)}`, { indent: 8 }));
    }
    doc.moveDown(0.8);
    doc.moveTo(56, doc.y).lineTo(56 + width, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.6);

    for (const b of policy.blocks()) {
      if (b.type === 'h2') {
        doc.moveDown(0.5).font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(b.text);
        doc.moveDown(0.2);
      } else if (b.type === 'h3') {
        doc.moveDown(0.25).font('Helvetica-Bold').fontSize(10.5).fillColor(TEXT).text(b.text);
      } else if (b.type === 'li') {
        doc.font('Helvetica').fontSize(10).fillColor(TEXT).text(`•  ${b.text}`, { indent: 10, paragraphGap: 1.5 });
      } else {
        doc.font('Helvetica').fontSize(10).fillColor(TEXT).text(b.text, { paragraphGap: 3, lineGap: 1 });
      }
    }

    // Signature block, kept together on one page.
    if (doc.y > doc.page.height - 260) doc.addPage();
    doc.moveDown(1.2);
    doc.moveTo(56, doc.y).lineTo(56 + width, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('Signature');
    doc.font('Helvetica').fontSize(10).fillColor(TEXT)
      .text('The reseller named above has read and agreed to this Reseller Agreement & Payment Policy and signed it electronically in the Mithmill reseller portal.');
    doc.moveDown(0.6);
    const sigTop = doc.y;
    try {
      doc.image(signature, 56, sigTop, { fit: [220, 90] });
    } catch {
      doc.text('(signature image could not be embedded)');
    }
    doc.y = sigTop + 96;
    doc.moveTo(56, doc.y).lineTo(276, doc.y).strokeColor(MUTED).stroke();
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT).text(signer.name);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
    if (signer.title) doc.text(signer.title);
    doc.text(`${reseller.brand || reseller.company || ''}${reseller.brand || reseller.company ? ' · ' : ''}${reseller.email}`);
    doc.text(`Signed: ${signedAt.toUTCString()}${ip ? ` · IP address ${ip}` : ''}`);
    doc.text(`Agreement version ${policy.VERSION}`);
    doc.end();
  });
}

module.exports = { build };
