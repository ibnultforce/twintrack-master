import { AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, VerticalAlign, WidthType, type ITableCellOptions } from 'docx';
import type { CompanyBankDetailsDoc } from '../models/masterData.js';
import type { InvoiceDoc } from '../models/invoice.js';

/**
 * The invoice as an editable Word document, laid out as the old app's: who bills whom, one table of work per project,
 * a summary, and where to pay. The unit price and amount columns are left empty on purpose, for whoever sends it to
 * fill in by hand, as the client expects.
 */

export const INVOICE_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface InvoiceDocumentInput {
  invoice: InvoiceDoc;
  clientAddress?: string;
  company: { name: string; address?: string };
  bankDetails: CompanyBankDetailsDoc | null;
}

const BORDER_COLOR = '999999';
const HEADER_SHADE = 'E2E8F0';
const NO_VALUE = '—';
const TITLE_SIZE = 36;
const HEADING_SIZE = 26;
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 2, color: BORDER_COLOR };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

const twoDigits = (value: number) => String(value).padStart(2, '0');
const dottedDate = (date: Date) => `${twoDigits(date.getUTCDate())}.${twoDigits(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
const dashedDate = (date: Date) => `${twoDigits(date.getUTCDate())}-${twoDigits(date.getUTCMonth() + 1)}-${String(date.getUTCFullYear()).slice(-2)}`;
const hours = (value: number) => value.toFixed(2);

interface CellOptions {
  width?: number;
  bold?: boolean;
  shade?: string;
  columnSpan?: number;
  align?: (typeof AlignmentType)[keyof typeof AlignmentType];
}

function cell(content: Paragraph[] | string, options: CellOptions = {}): TableCell {
  const children = typeof content === 'string' ? [new Paragraph({ alignment: options.align, children: [new TextRun({ text: content, bold: options.bold })] })] : content;
  const settings: ITableCellOptions = {
    children,
    borders: CELL_BORDERS,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    ...(options.width !== undefined && { width: { size: options.width, type: WidthType.PERCENTAGE } }),
    ...(options.columnSpan !== undefined && { columnSpan: options.columnSpan }),
    ...(options.shade !== undefined && { shading: { fill: options.shade } }),
  };
  return new TableCell(settings);
}

const labelled = (label: string, value: string | undefined) => new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun({ text: value || NO_VALUE })] });
const fullWidthTable = (rows: TableRow[]) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
const spacer = () => new Paragraph({ text: '', spacing: { after: 200 } });
const header = (text: string, width: number, align?: CellOptions['align']) => cell(text, { width, bold: true, shade: HEADER_SHADE, align });
const centered = (text: string, bold = false) => cell(text, { align: AlignmentType.CENTER, bold });

function partiesTable({ invoice, clientAddress, company }: InvoiceDocumentInput): Table {
  return fullWidthTable([
    new TableRow({ children: [cell([labelled('Bill To', invoice.clientName)], { width: 33 }), cell([labelled('Address', clientAddress)], { width: 34 }), cell([labelled('Invoice Number', invoice.invoiceNumber)], { width: 33 })] }),
    new TableRow({ children: [cell([labelled('Pay To', company.name)], { width: 33 }), cell([labelled('Address', company.address)], { width: 34 }), cell([labelled('Bill Date', dashedDate(invoice.createdAt))], { width: 33 })] }),
  ]);
}

function projectSections(invoice: InvoiceDoc): (Paragraph | Table)[] {
  return invoice.projects.flatMap((project) => {
    const lines = invoice.lines.filter((line) => line.projectId === project.projectId);
    const rows = [
      new TableRow({ tableHeader: true, children: [header('SL', 8, AlignmentType.CENTER), header('Date', 13, AlignmentType.CENTER), header('Project Detail Works', 59), header('Work Duration (hr/s)', 20, AlignmentType.CENTER)] }),
      ...lines.map((line, index) => new TableRow({ children: [centered(twoDigits(index + 1)), centered(dottedDate(line.date)), cell(line.description), centered(hours(line.hours))] })),
      new TableRow({ children: [cell('Total Duration of Works', { columnSpan: 3, bold: true, align: AlignmentType.CENTER }), centered(hours(project.totalHours), true)] }),
    ];
    return [new Paragraph({ spacing: { before: 200, after: 120 }, children: [new TextRun({ text: `Project Name: ${project.projectName}`, bold: true })] }), fullWidthTable(rows), new Paragraph({ text: '' })];
  });
}

function summarySection(invoice: InvoiceDoc): (Paragraph | Table)[] {
  const currency = invoice.currency;
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [header('SL', 8, AlignmentType.CENTER), header('Project Name', 42), header('Duration (hr/s)', 17, AlignmentType.CENTER), header(`Unit Price (${currency})`, 16, AlignmentType.CENTER), header(`Total Amount (${currency})`, 17, AlignmentType.CENTER)],
    }),
    ...invoice.projects.map((project, index) => new TableRow({ children: [centered(twoDigits(index + 1)), cell(project.projectName), centered(hours(project.totalHours)), cell(''), cell('')] })),
    new TableRow({ children: [cell('Grand Total Duration & Amount', { columnSpan: 2, bold: true }), centered(hours(invoice.totalHours), true), cell(''), cell('')] }),
  ];
  return [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 120 }, children: [new TextRun({ text: 'Project Summary & Financials', bold: true, size: HEADING_SIZE })] }), fullWidthTable(rows), spacer()];
}

function paymentSection(bank: CompanyBankDetailsDoc | null): (Paragraph | Table)[] {
  const details = [
    labelled('Bank Name', bank?.bankName),
    labelled('Account Name', bank?.accountName),
    labelled('Account Number', bank?.accountNumber),
    labelled('Branch Name', bank?.branchName),
    labelled('Routing Number', bank?.routingNumber),
    labelled('Swift Code', bank?.swiftCode),
    labelled('Address', bank?.address),
  ];
  return [
    new Paragraph({ spacing: { before: 100, after: 120 }, children: [new TextRun({ text: 'Payment Account Details:', bold: true })] }),
    fullWidthTable([new TableRow({ tableHeader: true, children: [cell('Bank', { bold: true, shade: HEADER_SHADE })] }), new TableRow({ children: [cell(details)] })]),
  ];
}

function notesSection(notes: string | undefined): Paragraph[] {
  const paragraphs = (notes ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];
  return [spacer(), new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Additional Information', bold: true, size: HEADING_SIZE })] }), ...paragraphs.map((text) => new Paragraph({ children: [new TextRun({ text })] }))];
}

export async function renderInvoiceDocument(input: InvoiceDocumentInput): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200, after: 200 }, children: [new TextRun({ text: 'INVOICE', bold: true, size: TITLE_SIZE })] }),
    partiesTable(input),
    spacer(),
    ...projectSections(input.invoice),
    ...summarySection(input.invoice),
    ...paymentSection(input.bankDetails),
    ...notesSection(input.invoice.additionalNotes),
  ];
  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }));
}
