import QRCode from 'qrcode';

/**
 * Utilitas QRIS DINAMIS.
 *
 * QRIS statis (yang biasa dicetak/di-print) tidak memuat nominal, sehingga saat di-scan user
 * harus mengetik nominal manual. QRIS dinamis MEMUAT nominal, jadi saat di-scan langsung
 * menagih sesuai tagihan.
 *
 * Konversi dilakukan pada payload EMVCo (string yang di-encode di dalam QR), BUKAN pembayaran
 * otomatis — dana tetap masuk ke QRIS/merchant kamu, konfirmasi tetap manual oleh admin.
 *
 * Langkah konversi (standar EMVCo QRIS):
 *   1. Buang tag CRC lama (tag 63, selalu 8 karakter terakhir: "6304XXXX").
 *   2. Set tag 01 (Point of Initiation) ke "12" (dinamis). Statis biasanya "010211".
 *   3. Sisipkan tag 54 (nominal transaksi) sebelum tag 58 ("5802ID" — country code).
 *   4. Tambahkan kembali "6304" lalu hitung ulang CRC16 (CCITT-FALSE) atas seluruh payload.
 */

// CRC16-CCITT (poly 0x1021, init 0xFFFF, tanpa refleksi) — dipakai QRIS.
function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Bangun tag TLV EMVCo: id(2) + panjang(2 digit) + value.
function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

/**
 * Ubah payload QRIS statis menjadi dinamis dengan nominal tertentu (Rupiah, tanpa desimal).
 * Mengembalikan string payload baru yang siap di-render jadi QR.
 */
export function buildDynamicQrisPayload(staticPayload: string, amount: number): string {
  // Hanya trim ujung (spasi/newline dari copy-paste). JANGAN hapus spasi di tengah —
  // nama merchant/kota (tag 59/60) sah mengandung spasi, mis. "TOKO KOPI", "JAKARTA PUSAT".
  let p = staticPayload.trim();

  // 1) Buang CRC lama. Tag 63 (CRC) selalu tag terakhir dan panjangnya 8 karakter ("6304" + 4 hex).
  if (p.length > 8 && p.slice(-8, -4) === '6304') {
    p = p.slice(0, -8);
  } else {
    const idx = p.lastIndexOf('6304');
    if (idx !== -1) p = p.slice(0, idx);
  }

  // 2) Set tag 01 ke "12" (dinamis).
  if (p.includes('010211')) {
    p = p.replace('010211', '010212');
  } else if (!p.includes('010212') && p.startsWith('000201')) {
    // Tag 01 tidak ada (default statis) → sisipkan setelah tag 00.
    p = '000201' + '010212' + p.slice(6);
  }

  // 3) Sisipkan tag 54 (nominal). Rupiah dibulatkan ke bilangan bulat.
  const amt = String(Math.max(0, Math.round(amount)));
  const tag54 = tlv('54', amt);
  const country = '5802ID';
  if (p.includes(country)) {
    p = p.replace(country, tag54 + country);
  } else {
    p = p + tag54;
  }

  // 4) Tambahkan placeholder CRC lalu hitung.
  p = p + '6304';
  return p + crc16(p);
}

// Render payload QRIS menjadi PNG (Buffer) untuk dilampirkan ke pesan Discord.
export function buildQrisPngBuffer(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: 'png',
    width: 420,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}
