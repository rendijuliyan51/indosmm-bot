import {
  ButtonInteraction, ModalSubmitInteraction, ModalBuilder,
  TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags,
} from 'discord.js';
import { prisma } from '../../bot/client';
import { buildServiceSelectRows } from '../../lib/embeds';

const MAX_RESULTS = 25; // batas 1 dropdown Discord

// Tombol "Cari Layanan" di katalog → tampilkan modal input keyword.
export async function handleCatalogSearchButton(interaction: ButtonInteraction): Promise<void> {
  const modal = new ModalBuilder().setCustomId('catalog_search_modal').setTitle('Cari Layanan');
  const input = new TextInputBuilder()
    .setCustomId('keyword')
    .setLabel('Kata kunci (nama / kategori layanan)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('mis. instagram followers indonesia')
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(100);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

// Submit modal pencarian → cari layanan (semua kata kunci harus cocok di nama+kategori),
// tampilkan hasil di dropdown yang sama seperti alur katalog biasa.
export async function handleCatalogSearchModal(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const keyword = interaction.fields.getTextInputValue('keyword').trim().toLowerCase();
  const terms   = keyword.split(/\s+/).filter(Boolean);

  const all = await prisma.service.findMany({
    where:   { active: true, hidden: false },
    orderBy: { price_sell: 'asc' },
  });

  const matches = all.filter(s => {
    const hay = `${s.name} ${s.category}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });

  if (matches.length === 0) {
    await interaction.editReply({
      content: `❌ Tidak ada layanan cocok dengan "${keyword}".\nCoba kata kunci lain, atau gunakan dropdown **Pilih Platform** di katalog.`,
    });
    return;
  }

  const shown = matches.slice(0, MAX_RESULTS);
  // slice ≤ 25 → buildServiceSelectRows tidak menambah tombol navigasi (yang tidak cocok untuk hasil search).
  const rows = buildServiceSelectRows(shown, 0);

  const note = matches.length > MAX_RESULTS
    ? `\n_Menampilkan ${MAX_RESULTS} dari ${matches.length} hasil — persempit kata kunci untuk lebih spesifik._`
    : '';

  await interaction.editReply({
    content:    `🔍 **${matches.length} hasil** untuk "${keyword}" — pilih layanan:${note}`,
    components: rows,
  });
}
