const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const uploadImage = require("../utils/imagekit");
const ticketModel = require("../models/ticket.model");
const { paiseToRupees } = require("./payment.service");

/**
 * The invoice, as a document the customer keeps.
 *
 * A closed job already produces a bill in WhatsApp and on three screens, and
 * every one of those is a message that scrolls away. This is the thing they
 * can forward to a landlord, attach to a claim, or find again next year - so
 * it carries the company's mark, its full name, the GST split and the invoice
 * number, and it looks like something a company issued rather than something
 * an app printed.
 *
 * Built with pdfkit rather than by rendering a web page. A headless browser
 * would give prettier CSS and would also mean shipping Chromium onto a small
 * VPS, several hundred megabytes of it, and a second process per invoice.
 * This draws straight to the page and finishes in milliseconds.
 *
 * Small on purpose. The type is the fourteen fonts every PDF reader already
 * has, so not a byte of font data is embedded; the mark is 160px, which is
 * ample for the 42pt it is drawn at; and the stream is compressed. A finished
 * invoice lands around 15 KB, which matters because every one of them is
 * stored and then downloaded over somebody's mobile data.
 *
 * The mark keeps its transparency. It was flattened onto white to save a few
 * kilobytes, and the header band behind it is paper rather than white - so
 * the saving bought a visible white square around the logo.
 */

/** The company, as it must appear on anything that is a tax document. */
const COMPANY = {
    name: "Cosmosgen Engineers Pvt. Ltd.",
    tagline: "Home services, done properly",
};

const LOGO = path.join(__dirname, "..", "..", "assets", "logo.png");

/* ---------- the palette, kept in step with the panels ---------- */

const INK = "#1a1a17";
const SOFT = "#65645d";
const FAINT = "#94928a";
const RULE = "#ded9cb";
const ACCENT = "#0f78d0";
const PAPER = "#f4f1e9";

const money = (paise) => "Rs " + paiseToRupees(paise);

const onDay = (value) =>
    new Date(value || Date.now()).toLocaleDateString("en-IN", {
        day: "numeric", month: "short", year: "numeric",
    });

/**
 * One row of the table, and the rule under it.
 *
 * Returns the y it finished at, so the caller can keep stacking without
 * counting line heights itself - a long description wraps onto a second line
 * and everything below has to move with it.
 */
const drawRow = (doc, { left, right, y, label, note, amount, bold }) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(INK);

    const amountWidth = 90;
    const textWidth = right - left - amountWidth - 10;

    doc.text(label, left, y, { width: textWidth });
    const afterLabel = doc.y;

    if (note) {
        doc.font("Helvetica").fontSize(8.5).fillColor(FAINT)
            .text(note, left, afterLabel + 1, { width: textWidth });
    }

    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor(INK)
        .text(amount, right - amountWidth, y, { width: amountWidth, align: "right" });

    return Math.max(doc.y, afterLabel) + 8;
};

const rule = (doc, left, right, y, colour = RULE) => {
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(colour).stroke();
};

/**
 * Draw the whole invoice and hand back the bytes.
 *
 * Resolved rather than streamed to a file: the only thing that happens next is
 * an upload, and writing it to the server's disk first would leave a folder of
 * invoices nobody ever cleans up.
 */
const buildInvoicePdf = (ticket) =>
    new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "A4", margin: 0, compress: true });

            const chunks = [];
            doc.on("data", (c) => chunks.push(c));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            const left = 48;
            const right = doc.page.width - 48;

            const bill = ticket.billing || {};
            const customer = ticket.customerSnapshot || {};
            const tech = ticket.technicianSnapshot || {};

            /* ---------- the band across the top ---------- */

            doc.rect(0, 0, doc.page.width, 132).fill(PAPER);

            try {
                if (fs.existsSync(LOGO)) doc.image(LOGO, left, 34, { width: 42 });
            } catch {
                // A missing mark is not a reason to withhold somebody's bill.
            }

            doc.font("Helvetica-Bold").fontSize(15).fillColor(INK)
                .text(COMPANY.name, left + 54, 40);
            doc.font("Helvetica").fontSize(8.5).fillColor(SOFT)
                .text(COMPANY.tagline, left + 54, 59);

            doc.font("Helvetica-Bold").fontSize(21).fillColor(INK)
                .text("INVOICE", right - 200, 38, { width: 200, align: "right" });
            doc.font("Helvetica").fontSize(9).fillColor(SOFT)
                .text(bill.invoiceNumber || ticket.ticketNumber, right - 200, 64, { width: 200, align: "right" });
            doc.fontSize(9).fillColor(FAINT)
                .text(onDay(ticket.updatedAt), right - 200, 78, { width: 200, align: "right" });

            /* ---------- who it is for, and what it was ---------- */

            let y = 168;

            doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT)
                .text("BILLED TO", left, y);
            doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT)
                .text("THE JOB", left + 270, y);

            y += 14;

            doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
                .text(customer.name || "Customer", left, y, { width: 250 });

            const addressLines = [customer.address, customer.area, customer.landmark]
                .map((part) => String(part || "").trim())
                .filter(Boolean)
                .filter((part, i, all) => !all.slice(0, i).some((earlier) => earlier.includes(part)));

            doc.font("Helvetica").fontSize(9).fillColor(SOFT)
                .text(addressLines.join(", ") || "-", left, doc.y + 2, { width: 250 });

            if (customer.phone) {
                doc.fillColor(SOFT).text(customer.phone, left, doc.y + 1, { width: 250 });
            }

            const leftEnd = doc.y;

            doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
                .text(ticket.serviceLabel || "Service", left + 270, y, { width: 230 });
            doc.font("Helvetica").fontSize(9).fillColor(SOFT)
                .text("Ticket " + ticket.ticketNumber, left + 270, doc.y + 2, { width: 230 });

            if (tech.name) {
                doc.fillColor(SOFT).text("Attended by " + tech.name, left + 270, doc.y + 1, { width: 230 });
            }

            y = Math.max(leftEnd, doc.y) + 26;

            /* ---------- what was charged ---------- */

            rule(doc, left, right, y);
            y += 12;

            doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT)
                .text("DESCRIPTION", left, y);
            doc.text("AMOUNT", right - 90, y, { width: 90, align: "right" });

            y += 16;
            rule(doc, left, right, y);
            y += 12;

            const items = Array.isArray(bill.lineItems) ? bill.lineItems : [];

            /*
             * Where a new page has to start.
             *
             * Rows are placed by hand rather than flowed, so pdfkit will
             * happily draw the twentieth one straight through the footer and
             * off the paper. The office allows up to twenty line items, and a
             * long job with a dozen parts is exactly the invoice somebody
             * keeps - so the break is real, not theoretical.
             */
            const lastRowY = doc.page.height - 200;

            const freshPage = () => {
                doc.addPage();
                doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT)
                    .text("DESCRIPTION (continued)", left, 56);
                doc.text("AMOUNT", right - 90, 56, { width: 90, align: "right" });
                rule(doc, left, right, 72);
                return 86;
            };

            if (items.length) {
                items.forEach((item) => {
                    if (y > lastRowY) y = freshPage();

                    const qty = Number(item.qty || 1);
                    y = drawRow(doc, {
                        left, right, y,
                        label: item.description || "Work carried out",
                        note: qty > 1 ? qty + " x " + money(Math.round((item.amountPaise || 0) / qty)) : null,
                        amount: money(item.amountPaise),
                    });
                });

                // The sums must not be orphaned from the total either: if the
                // last row landed near the foot, they start a page of their own.
                if (y > lastRowY) y = freshPage();
            } else {
                y = drawRow(doc, {
                    left, right, y,
                    label: bill.workDone || "Work carried out",
                    amount: money(bill.totalPaise),
                });
            }

            y += 4;
            rule(doc, left, right, y);
            y += 14;

            /* ---------- the sums ---------- */

            const sumLeft = right - 240;

            const sum = (label, amount, bold) => {
                doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10)
                    .fillColor(bold ? INK : SOFT)
                    .text(label, sumLeft, y, { width: 140 });
                doc.fillColor(bold ? INK : INK)
                    .text(amount, right - 100, y, { width: 100, align: "right" });
                y += bold ? 22 : 17;
            };

            sum("Subtotal", money(bill.subtotalPaise));

            if (bill.gstPaise) {
                sum("GST (" + (bill.gstPercent || 0) + "%)", money(bill.gstPaise));
            }

            y += 2;
            rule(doc, sumLeft, right, y);
            y += 12;

            sum("Total paid", money(bill.totalPaise), true);

            /* ---------- how it was paid ---------- */

            const method = {
                cash: "Cash, to the engineer",
                online: "Online, to the company",
                split: "Part cash to the engineer, part online",
                visit: "Visit charge",
            }[ticket.payment?.method] || ticket.payment?.method || "-";

            doc.font("Helvetica").fontSize(9).fillColor(SOFT)
                .text("Paid by: " + method, left, y - 34, { width: 240 });

            if (ticket.payment?.status) {
                doc.fillColor(FAINT).text("Status: " + ticket.payment.status, left, doc.y + 1, { width: 240 });
            }

            y += 18;

            /* ---------- what was actually done ---------- */

            if (bill.workDone) {
                // The note is the last thing on the page and the first thing
                // to collide with the footer, so it moves rather than overlaps.
                if (y > doc.page.height - 170) {
                    doc.addPage();
                    y = 60;
                }

                rule(doc, left, right, y);
                y += 14;

                doc.font("Helvetica-Bold").fontSize(8).fillColor(FAINT)
                    .text("WORK CARRIED OUT", left, y);

                doc.font("Helvetica").fontSize(9.5).fillColor(INK)
                    .text(bill.workDone, left, doc.y + 6, { width: right - left });
            }

            /* ---------- the foot ---------- */

            const footY = doc.page.height - 74;

            rule(doc, left, right, footY);

            doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
                .text(COMPANY.name, left, footY + 12);
            doc.font("Helvetica").fontSize(8).fillColor(FAINT)
                .text("This invoice is generated from the company's own records. No signature is required.",
                    left, footY + 25, { width: right - left - 120 });

            doc.font("Helvetica").fontSize(8).fillColor(ACCENT)
                .text("cosmosgen.com", right - 120, footY + 12, { width: 120, align: "right" });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });

/**
 * Build it, put it on ImageKit, and remember where it went.
 *
 * The URL lives on the ticket rather than being worked out from the invoice
 * number, because ImageKit appends its own suffix when a name is already
 * taken - so the only reliable address is the one it hands back.
 *
 * Never throws at the caller. This runs at the moment a job closes, and a
 * failed upload must not undo a closed job or a collected payment - the bill
 * has already gone to the customer in WhatsApp as text either way.
 */
const publishInvoice = async (ticket) => {
    if (!ticket?._id) return null;

    try {
        const pdf = await buildInvoicePdf(ticket);

        const name = (ticket.billing?.invoiceNumber || ticket.ticketNumber || "invoice")
            .replace(/[^A-Za-z0-9-]/g, "-") + ".pdf";

        const uploaded = await uploadImage(pdf, name, "Invoices");
        const url = uploaded?.url;

        if (!url) return null;

        await ticketModel.updateOne(
            { _id: ticket._id },
            { $set: { "billing.invoicePdfUrl": url } }
        );

        console.log("[INVOICE] " + name + " published (" + Math.round(pdf.length / 1024) + " KB)");
        return url;
    } catch (err) {
        console.error("[INVOICE] could not publish for " + ticket.ticketNumber + ": " + err.message);
        return null;
    }
};

module.exports = { buildInvoicePdf, publishInvoice };
