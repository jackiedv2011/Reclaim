import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, X } from 'lucide-react'
import { parseCsv, type ParseOptions } from '@/lib/csv'
import { FIELD_LABELS, OPTIONAL_FIELDS, REQUIRED_FIELDS, columnName, dataRows, dateOrderEvidence, invoiceAmountsAllNegative, isBlankRow, negativePayments, suggestColumns, type ColumnMap, type CsvField, type CsvTable } from '@/lib/csvMapping'
import { parseCurrency, parseDate, type DateOrder } from '@/lib/format'
import type { ParseResult } from '@/types'

const FIELD_HELP: Partial<Record<CsvField, string>> = {
  vendor: 'Who was paid',
  payment_date: 'The day the money went out',
  amount_paid: 'What was actually paid',
  invoice_number: 'Used to find invoices paid twice. Not a check number.',
  invoice_amount: 'Used to find overpayments',
  bank_account_last4: 'Used to find changed bank details',
  terms: 'Used with invoice date and amount to check discounts',
}

const PREVIEW_ROWS = 5
const HEADER_CHOICES = 15

/** Choices a person has made about a file; the same shape parseCsv takes. */
export type ColumnChoices = ParseOptions & { headerIndex: number; columns: ColumnMap }

function longDate(date: Date, order: DateOrder): string {
  return new Intl.DateTimeFormat(order === 'month-first' ? 'en-US' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
}

const listOf = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`)

interface ColumnMatchProps {
  table: CsvTable
  filename: string
  /** Choices to come back to, when the person returns to this step. */
  initial: ColumnChoices | null
  notice: string | null
  onCancel: () => void
  onDone: (parsed: ParseResult, choices: ColumnChoices) => void
}

/** The step between choosing a file and confirming it, for a file Reclaim can't read without asking something. */
export function ColumnMatch({ table, filename, initial, notice, onCancel, onDone }: ColumnMatchProps) {
  const id = useId()
  const [headerIndex, setHeaderIndex] = useState(initial?.headerIndex ?? table.headerIndex)
  const suggestion = useMemo(() => suggestColumns(table, headerIndex), [table, headerIndex])
  const [columns, setColumns] = useState<ColumnMap>(initial?.columns ?? suggestion.columns)
  const [chosenOrder, setChosenOrder] = useState<DateOrder | null>(() =>
    // An order the file proved was never the person's answer, so it must not stand in for one.
    initial?.dateOrder && dateOrderEvidence(table, initial.columns, initial.headerIndex).order === null ? initial.dateOrder : null
  )
  const [sign, setSign] = useState<'flip' | 'keep' | null>(initial?.flipSign === undefined ? null : initial.flipSign ? 'flip' : 'keep')
  const [problem, setProblem] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])

  const headings = useMemo(() => table.rows[headerIndex] ?? [], [table, headerIndex])
  const rows = useMemo(() => dataRows(table, headerIndex), [table, headerIndex])
  const evidence = useMemo(() => dateOrderEvidence(table, columns, headerIndex), [table, columns, headerIndex])
  const dateOrder = evidence.order ?? chosenOrder
  const negative = useMemo(() => negativePayments(table, columns, dateOrder ?? 'month-first', headerIndex), [table, columns, dateOrder, headerIndex])
  const invoicesNegative = useMemo(() => invoiceAmountsAllNegative(table, columns, headerIndex), [table, columns, headerIndex])

  const preview = useMemo(() => {
    const shown: { rowNumber: number; cells: string[] }[] = []
    for (let position = headerIndex + 1; position < table.rows.length && shown.length < PREVIEW_ROWS; position += 1) {
      if (table.rows[position].some((cell) => cell.trim() !== '')) shown.push({ rowNumber: position + 1, cells: table.rows[position] })
    }
    return shown
  }, [table, headerIndex])
  const titleLines = table.rows.slice(0, headerIndex).filter((row) => row.some((cell) => cell.trim() !== ''))
  const headerChoices = useMemo(() => {
    const indexes: number[] = []
    for (let index = 0; index < table.rows.length && indexes.length < HEADER_CHOICES; index += 1) if (!isBlankRow(table.rows[index])) indexes.push(index)
    return indexes.includes(headerIndex) ? indexes : [...indexes, headerIndex]
  }, [table, headerIndex])
  const fieldOf = useMemo(() => new Map((Object.entries(columns) as [CsvField, number][]).map(([field, index]) => [index, field])), [columns])

  const missing: string[] = REQUIRED_FIELDS.filter((field) => columns[field] === undefined).map((field) => FIELD_LABELS[field].toLowerCase())
  if (dateOrder === null) missing.push('which way round the dates are')
  if (negative && sign === null) missing.push('whether the negative amounts are payments')

  function chooseHeader(index: number) {
    setHeaderIndex(index)
    setColumns(suggestColumns(table, index).columns)
    setChosenOrder(null)
    setSign(null)
    setProblem(null)
  }

  function chooseColumn(field: CsvField, value: string) {
    const next: ColumnMap = { ...columns }
    if (value === '') delete next[field]
    else {
      // One column feeds one field, so picking it here takes it from wherever it was.
      for (const other of Object.keys(next) as CsvField[]) if (next[other] === Number(value)) delete next[other]
      next[field] = Number(value)
    }
    // An answer about one column's dates or signs says nothing about another's.
    if (next.payment_date !== columns.payment_date || next.invoice_date !== columns.invoice_date) setChosenOrder(null)
    if (next.amount_paid !== columns.amount_paid) setSign(null)
    setColumns(next)
    setProblem(null)
  }

  function finish() {
    if (missing.length > 0 || dateOrder === null) return
    const choices: ColumnChoices = { headerIndex, columns, dateOrder, ...(negative ? { flipSign: sign === 'flip' } : {}) }
    const parsed = parseCsv(table, choices)
    if (parsed.records.length === 0) {
      const first = parsed.rowResults?.find((row) => row.status === 'rejected')
      setProblem(`None of the ${rows.length} rows could be read with these choices.${first ? ` Row ${first.rowNumber}: ${first.reason}.` : ''} Check that each field points at the right column.`)
      return
    }
    onDone(parsed, choices)
  }

  function fieldNote(field: CsvField): string | null {
    const options = suggestion.ambiguous[field]
    if (columns[field] === undefined && options) return `Could be ${listOf(options.map((index) => `“${columnName(headings, index)}”`))}. Choose one.`
    if (columns[field] !== undefined && suggestion.suggested.includes(field) && columns[field] === suggestion.columns[field]) return 'Suggested. Check it is right.'
    return FIELD_HELP[field] ?? null
  }

  const fieldSelect = (field: CsvField, required: boolean) => {
    const note = fieldNote(field)
    const selectId = `${id}-${field}`
    return (
      <div className="wk-field" key={field}>
        <label htmlFor={selectId}>{FIELD_LABELS[field]}</label>
        <select
          id={selectId}
          className="wk-input"
          value={columns[field] ?? ''}
          required={required}
          aria-describedby={note ? `${selectId}-note` : undefined}
          onChange={(event) => chooseColumn(field, event.target.value)}
        >
          <option value="">{required ? 'Choose a column' : 'Not in this file'}</option>
          {headings.map((_, index) => {
            const example = rows.find((row) => (row[index] ?? '').trim() !== '')?.[index].trim()
            return (
              <option key={index} value={index}>
                {columnName(headings, index)}
                {example ? ` (${example.length > 28 ? `${example.slice(0, 27)}…` : example})` : ''}
              </option>
            )
          })}
        </select>
        {note ? <small id={`${selectId}-note`} className="wk-field-hint">{note}</small> : null}
      </div>
    )
  }

  const headingsKnown = REQUIRED_FIELDS.every((field) => suggestion.recognized.includes(field)) && Object.keys(suggestion.ambiguous).length === 0
  const asks = evidence.question !== null || negative !== null
  const optionalMatched = OPTIONAL_FIELDS.filter((field) => columns[field] !== undefined).length
  // Decided once, from how the file arrived, so the section never closes under the person's hands.
  const [optionalOpen] = useState(OPTIONAL_FIELDS.some((field) => suggestion.ambiguous[field] || suggestion.suggested.includes(field)))
  const orderExample = evidence.example
  const readings = (['month-first', 'day-first'] as const).map((order) => ({ order, date: orderExample ? parseDate(orderExample, order) : null }))
  const negativeExample = negative ? parseCurrency(negative.example) : null

  return (
    <div className="wk wk-import" data-state="matching">
      <h2 className="wk-sr" ref={headingRef} tabIndex={-1}>Match the columns</h2>
      <p className="wk-import-intro">
        {!headingsKnown
          ? `Reclaim doesn’t know all the headings in ${filename}. Check which column is which. Your file isn’t changed.`
          : asks
            ? `Reclaim knows the headings in ${filename}, but needs your answer below before it reads the file.`
            : `Reclaim knows the headings in ${filename}. Change any match that is wrong.`}
      </p>

      {notice ? (
        <div className="wk-callout" data-tone="warn" role="status">
          <AlertCircle aria-hidden="true" />
          <div className="wk-callout-body"><p>{notice}</p></div>
        </div>
      ) : null}

      <div className="wk-match-section">
        <div className="wk-match-head">
          <span className="wk-label">First rows of the file</span>
          <label className="wk-match-row">
            Headings are on row
            <select className="wk-input" value={headerIndex + 1} onChange={(event) => chooseHeader(Number(event.target.value) - 1)}>
              {headerChoices.map((index) => <option key={index} value={index + 1}>{index + 1}</option>)}
            </select>
          </label>
        </div>
        {titleLines.length > 0 ? (
          <p className="wk-match-note">
            Skipping {titleLines.length} line{titleLines.length === 1 ? '' : 's'} above the headings: {titleLines.slice(0, 3).map((row) => `“${row.filter((cell) => cell.trim() !== '').join(', ').trim()}”`).join(', ')}{titleLines.length > 3 ? '…' : ''}
          </p>
        ) : null}
        <div className="wk-table-wrap wk-match-table" tabIndex={0} role="region" aria-label="First rows of the file">
          <table className="wk-table">
            <thead>
              <tr>
                <th scope="col">Row</th>
                {headings.map((_, index) => {
                  const field = fieldOf.get(index)
                  return (
                    <th scope="col" key={index} data-matched={field ? true : undefined}>
                      {columnName(headings, index)}
                      {field ? <small>{FIELD_LABELS[field]}</small> : null}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.rowNumber}>
                  <th scope="row">{row.rowNumber}</th>
                  {headings.map((_, index) => <td key={index} data-matched={fieldOf.has(index) ? true : undefined}>{row.cells[index] ?? ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wk-match-grid">{REQUIRED_FIELDS.map((field) => fieldSelect(field, true))}</div>

      {evidence.question ? (
        <fieldset className="wk-match-question">
          <legend>Which way round are the dates?</legend>
          <p className="wk-match-note">
            {evidence.question === 'mixed'
              ? `The file has both: ${evidence.monthFirst} date${evidence.monthFirst === 1 ? ' only works' : 's only work'} month first and ${evidence.dayFirst} only day first. Rows that don’t fit your answer are skipped and listed.`
              : 'Every date in this file could be read either way, so Reclaim can’t tell from the file alone.'}
          </p>
          <div className="wk-match-options">
            {readings.map(({ order, date }) => (
              <label className="wk-radio" key={order}>
                <input type="radio" name={`${id}-order`} checked={chosenOrder === order} onChange={() => { setChosenOrder(order); setProblem(null) }} />
                <span>
                  {order === 'month-first' ? 'Month first' : 'Day first'}
                  {orderExample ? <small>{date ? `${orderExample} is ${longDate(date, order)}` : `${orderExample} can’t be read this way`}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {negative && negativeExample !== null ? (
        <fieldset className="wk-match-question">
          <legend>Are these negative amounts payments?</legend>
          <p className="wk-match-note">
            {negative.count === 1 ? 'The only amount paid in this file is negative.' : `All ${negative.count} amounts paid in this file are negative.`} Reclaim reads a negative amount as a refund or credit and never checks it as a payment, so left as it is this file would find nothing.
          </p>
          <div className="wk-match-options">
            <label className="wk-radio">
              <input type="radio" name={`${id}-sign`} checked={sign === 'flip'} onChange={() => setSign('flip')} />
              <span>
                Yes, flip the sign
                <small>{negative.example} is read as {new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(-negativeExample)}, a payment{invoicesNegative ? '. Invoice amounts, which are all negative too, are flipped the same way' : ''}. Each record keeps the amount as your file wrote it.</small>
              </span>
            </label>
            <label className="wk-radio">
              <input type="radio" name={`${id}-sign`} checked={sign === 'keep'} onChange={() => setSign('keep')} />
              <span>
                No, they are refunds or credits
                <small>They are kept negative and not checked as payments.</small>
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}

      <details className="wk-match-details" open={optionalOpen}>
        <summary>Optional columns{optionalMatched > 0 ? ` (${optionalMatched} matched)` : ''}</summary>
        <p className="wk-match-note">Each one you match lets more checks run. Leave out anything the file doesn’t have.</p>
        <div className="wk-match-grid">{OPTIONAL_FIELDS.map((field) => fieldSelect(field, false))}</div>
      </details>

      {problem ? (
        <div className="wk-callout" data-tone="danger" role="alert">
          <AlertCircle aria-hidden="true" />
          <div className="wk-callout-body"><p>{problem}</p></div>
        </div>
      ) : null}

      <div className="wk-panel-foot">
        <p className="wk-panel-foot-note" aria-live="polite">{missing.length > 0 ? `Still to choose: ${missing.join(', ')}.` : ''}</p>
        <button type="button" className="wk-btn" data-variant="outline" onClick={onCancel}>
          <X aria-hidden="true" />
          Choose a different file
        </button>
        <button type="button" className="wk-btn" data-variant="primary" disabled={missing.length > 0} onClick={finish}>
          Continue
          <ArrowRight aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
