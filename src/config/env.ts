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
  QRIS_IMAGE_URL:       required('QRIS_IMAGE_URL'),
  MARKUP_PERCENTAGE:    parseFloat(optional('MARKUP_PERCENTAGE', '40')),
  LOW_BALANCE_THRESHOLD: parseFloat(optional('LOW_BALANCE_THRESHOLD', '50000')),
  DATABASE_URL:         optional('DATABASE_URL', 'file:./dev.db'),
  TZ:                   optional('TZ', 'Asia/Jakarta'),

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
