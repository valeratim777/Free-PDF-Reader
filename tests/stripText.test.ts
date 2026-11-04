import { describe, expect, it } from 'vitest';
import { stripText } from '../src/export/stripText';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const area = [{ x1: 60, y1: 690, x2: 300, y2: 715 }];

describe('removing the original text under a translation', () => {
  it('removes text that starts inside the area and keeps the rest', () => {
    const out = dec(stripText(enc('BT /F1 12 Tf 72 700 Td (Hello) Tj 0 -200 Td (Stay) Tj ET'), area));
    expect(out).not.toContain('(Hello) Tj');
    expect(out).toContain('(Stay) Tj');
    expect(out).toContain('0 -200 Td');
    expect(out).toContain('72 700 Td');
  });

  it('returns null when nothing is inside', () => {
    expect(stripText(enc('BT 72 100 Td (Far away) Tj ET'), area)).toBeNull();
    expect(stripText(enc('BT 72 700 Td (Hi) Tj ET'), [])).toBeNull();
  });

  it('follows the text and transformation matrices', () => {
    expect(dec(stripText(enc('q 1 0 0 1 50 650 cm BT 1 0 0 1 22 50 Tm [(A)-20(B)] TJ ET Q'), area))).not.toContain('TJ');
    // Moved out of the area by the transformation.
    expect(stripText(enc('q 1 0 0 1 0 -500 cm BT 72 700 Td (A) Tj ET Q'), area)).toBeNull();
    // The leading of TD and T* is followed.
    const out = dec(stripText(enc('BT 72 750 TD (Above) Tj 0 -50 TD (Inside) Tj T* (Below) Tj ET'), area));
    expect(out).toContain('(Above) Tj');
    expect(out).not.toContain('(Inside)');
    expect(out).toContain('(Below) Tj');
  });

  it('keeps text shown in a row without a new position (later text would shift)', () => {
    expect(stripText(enc('BT 72 700 Td (Hello ) Tj /F2 12 Tf (world) Tj ET'), area)).toBeNull();
  });

  it('keeps TJ arrays with big jumps that may reach into other areas', () => {
    expect(stripText(enc('BT 72 700 Td [(North) -15000 (1 250 000)] TJ ET'), area)).toBeNull();
  });

  it('keeps the line movement and spacing of the quote operators', () => {
    const out = dec(stripText(enc("BT 14 TL 72 714 Td (x) ' ET"), area));
    expect(out).toMatch(/T\*/);
    expect(out).not.toContain('(x)');
    const out2 = dec(stripText(enc('BT 14 TL 72 714 Td 2 1 (y) " ET'), area));
    expect(out2).toContain('2 Tw 1 Tc T*');
  });

  it('reads strings, names, dictionaries and comments correctly', () => {
    const src = '/P <</MCID 0 /Alt (a >> b) /Sub <</X [1 2]>>>> BDC % comment (not a string\nBT 72 700 Td (a \\) tricky (nested) one) Tj ET EMC';
    const out = dec(stripText(enc(src), area));
    expect(out).not.toContain('tricky');
    expect(out).toContain('BDC');
    expect(out).toContain('EMC');
    expect(dec(stripText(enc('BT 72 700 Td <48656C6C6F> Tj ET'), area))).not.toContain('<48656C6C6F>');
  });

  it('leaves streams it cannot read safely alone', () => {
    expect(stripText(enc('BI /W 1 /H 1 ID \x00\xff EI BT 72 700 Td (A) Tj ET'), area)).toBeNull();
    expect(stripText(enc('BT 72 700 Td (unterminated Tj ET'), area)).toBeNull();
    expect(stripText(enc('BT 72 700 Td [(A) Tj ET'), area)).toBeNull();
  });
});
