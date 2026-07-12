import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const ENV = {
  DISCORD_TOKEN:        required('DISCORD_TOKEN'),
  DISCORD_CLIENT_ID:    required('DISCORD_CLIENT_ID'),
  ADMIN_ROLE_ID:        required('ADMIN_ROLE_ID'),
  ADMIN_LOG_CHANNEL_ID: required('ADMIN_LOG_CHANNEL_ID'),
  TICKET_CATEGORY_ID:   optional('TICKET_CATEGORY_ID', ''),
  INDOSMM_API_URL:      required('INDOSMM_API_URL'),
  INDOSMM_API_KEY:      required('INDOSMM_API_KEY'),
  QRIS_IMAGE_URL:       optional('QRIS_IMAGE_URL', ''),
  // Payload QRIS STATIS kamu (string EMVCo yang di-encode di dalam gambar QRIS, diawali
  // "00020101..."). Kalau diisi, bot akan membuat QRIS DINAMIS otomatis dengan nominal
  // sesuai tagihan tiap order. Cara ambil: decode gambar QRIS kamu pakai QR reader.
  QRIS_STATIC_PAYLOAD:  optional('QRIS_STATIC_PAYLOAD', ''),
  MARKUP_PERCENTAGE:    parseFloat(optional('MARKUP_PERCENTAGE', '40')),
  LOW_BALANCE_THRESHOLD: parseFloat(optional('LOW_BALANCE_THRESHOLD', '50000')),
  // Minimum nilai tagihan (Rp) per order. Order dengan total di bawah ini ditolak. Alasan:
  // deposit minimum di IndoSMM Rp 10.000, jadi order bertagihan sangat kecil (mis. Rp 2.000)
  // tidak ekonomis. Set 0 untuk menonaktifkan minimum belanja.
  MIN_ORDER_BILL:       parseFloat(optional('MIN_ORDER_BILL', '10000')),
  // Batas jumlah ticket AKTIF yang boleh dimiliki satu user sekaligus. User boleh membuka
  // beberapa ticket untuk layanan/platform BERBEDA (mis. Instagram + TikTok) selama belum
  // melewati batas ini. Set 0 untuk tanpa batas. (Order duplikat pada link+layanan yang sama
  // tetap dicegah terpisah.)
  MAX_ACTIVE_TICKETS_PER_USER: parseInt(optional('MAX_ACTIVE_TICKETS_PER_USER', '5'), 10),
  // Default masa garansi/refill (hari) untuk layanan yang MENDUKUNG refill tapi jumlah harinya
  // tidak tercantum di nama layanan. Tanpa ini, masa garansi = 0 dan refill langsung dianggap
  // expired (tidak bisa diklaim). Set 0 untuk tidak memberi default (garansi mengikuti nama saja).
  REFILL_DEFAULT_DAYS:  parseInt(optional('REFILL_DEFAULT_DAYS', '30'), 10),
  // Jeda (jam) sebelum tiket yang ordernya SUDAH selesai ditutup otomatis. Memberi waktu pembeli
  // membaca notif & memberi rating. Refill tetap bisa diklaim lewat /order refill walau tiket
  // sudah tutup (garansi disimpan di level order). Set 0 untuk tutup segera setelah selesai.
  TICKET_AUTOCLOSE_HOURS: parseFloat(optional('TICKET_AUTOCLOSE_HOURS', '24')),
  // Selang cek & notif saldo IndoSMM (jam). Default 6 jam biar tidak spam tiap jam.
  BALANCE_CHECK_INTERVAL_HOURS: parseFloat(optional('BALANCE_CHECK_INTERVAL_HOURS', '6')),
  DATABASE_URL:         optional('DATABASE_URL', 'file:./dev.db'),
  TZ:                   optional('TZ', 'Asia/Jakarta'),
  // URL health-check untuk monitoring uptime (opsional). Bila diisi, bot mem-ping tiap 5 menit;
  // kalau bot mati, ping berhenti dan layanan monitor akan memberi tahu kamu.
  HEALTHCHECK_URL:      optional('HEALTHCHECK_URL', ''),
  // Channel untuk auto-post testimoni pembeli (opsional). Hanya rating bintang 4 & 5 yang
  // diposting. Kosongkan untuk menonaktifkan (review tetap tersimpan & dihitung di /admin stats).
  TESTIMONIAL_CHANNEL_ID: optional('TESTIMONIAL_CHANNEL_ID', ''),

  EMOJI: {
    // Platform
    INSTAGRAM:  optional('EMOJI_INSTAGRAM',  '📸'),
    TIKTOK:     optional('EMOJI_TIKTOK',     '🎵'),
    YOUTUBE:    optional('EMOJI_YOUTUBE',    '▶️'),
    FACEBOOK:   optional('EMOJI_FACEBOOK',   '👤'),
    TWITTER:    optional('EMOJI_TWITTER',    '🐦'),
    TELEGRAM:   optional('EMOJI_TELEGRAM',   '✈️'),
    SPOTIFY:    optional('EMOJI_SPOTIFY',    '🎧'),
    SHOPEE:     optional('EMOJI_SHOPEE',     '🛍️'),
    SNACKVIDEO: optional('EMOJI_SNACKVIDEO', '🍿'),
    ROBLOX:     optional('EMOJI_ROBLOX',     '🎮'),
    GITHUB:     optional('EMOJI_GITHUB',     '💻'),
    PINTEREST:  optional('EMOJI_PINTEREST',  '📌'),
    LINE:       optional('EMOJI_LINE',       '💬'),
    THREADS:    optional('EMOJI_THREADS',    '🧵'),
    WHATSAPP:   optional('EMOJI_WHATSAPP',   '📱'),
    LINKEDIN:   optional('EMOJI_LINKEDIN',   '💼'),
    // UI
    SUCCESS:    optional('EMOJI_SUCCESS',    '✅'),
    ERROR:      optional('EMOJI_ERROR',      '❌'),
    WARNING:    optional('EMOJI_WARNING',    '⚠️'),
    PROCESSING: optional('EMOJI_PROCESSING', '⚙️'),
    WAITING:    optional('EMOJI_WAITING',    '⏳'),
    COMPLETED:  optional('EMOJI_COMPLETED',  '🎉'),
    TICKET:     optional('EMOJI_TICKET',     '🎫'),
    INVOICE:    optional('EMOJI_INVOICE',    '🧾'),
    PAYMENT:    optional('EMOJI_PAYMENT',    '💳'),
    REFILL:     optional('EMOJI_REFILL',     '🔄'),
    CLOSE:      optional('EMOJI_CLOSE',      '🔒'),
    ADMIN:      optional('EMOJI_ADMIN',      '👑'),
    MONEY:      optional('EMOJI_MONEY',      '💰'),
    LINK:       optional('EMOJI_LINK',       '🔗'),
    QUANTITY:   optional('EMOJI_QUANTITY',   '📦'),
    TIME:       optional('EMOJI_TIME',       '🕐'),
    SHIELD:     optional('EMOJI_SHIELD',     '🛡️'),
    CHART:      optional('EMOJI_CHART',      '📊'),
  },
};
