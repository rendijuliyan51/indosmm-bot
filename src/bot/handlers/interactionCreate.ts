import {
  Interaction,
  StringSelectMenuInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { logger } from '../../lib/logger';
import { handleAdminCommand } from '../../commands/admin/admin';
import { handleCatalogSelectCategory, selectedCategoryMap } from '../../commands/user/catalogSelectCategory';
import { handleCatalogSelectType } from '../../commands/user/catalogSelectType';
import { handleCatalogSelectService } from '../../commands/user/catalogSelectService';
import { handleOrderNow } from '../../commands/user/orderNow';
import { handleOrderModal } from '../../commands/user/orderModal';
import { handlePaymentApprove, handlePaymentReject } from '../../commands/admin/paymentHandler';
import { handleRefillRequest } from '../../commands/user/refillRequest';
import { handleTicketClose } from '../../commands/user/ticketClose';
import { selectedServiceMap } from '../../commands/user/catalogSelectService';
import { ENV } from '../../config/env';

function isAdmin(interaction: Interaction): boolean {
  if (!('member' in interaction) || !interaction.member) return false;
  const roles = (interaction.member as any).roles;
  if (Array.isArray(roles)) return roles.includes(ENV.ADMIN_ROLE_ID);
  if ('cache' in roles) return roles.cache.has(ENV.ADMIN_ROLE_ID);
  return false;
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'admin') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '❌ Kamu tidak memiliki akses admin.', ephemeral: true });
          return;
        }
        await handleAdminCommand(interaction);
        return;
      }
      if (interaction.commandName === 'ticket') {
        const { handleTicketCommand } = await import('../../commands/user/ticketCommand');
        await handleTicketCommand(interaction);
        return;
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const i = interaction as StringSelectMenuInteraction;
      if (i.customId === 'catalog_select_category') { await handleCatalogSelectCategory(i); return; }
      if (i.customId === 'catalog_select_type')     { await handleCatalogSelectType(i);     return; }
      if (i.customId === 'catalog_select_service')  { await handleCatalogSelectService(i);  return; }
      return;
    }

    if (interaction.isButton()) {
      const i = interaction as ButtonInteraction;
      if (i.customId === 'catalog_order_now') { await handleOrderNow(i); return; }
      if (i.customId === 'catalog_cancel_order') {
        selectedServiceMap.delete(i.user.id);
        selectedCategoryMap.delete(i.user.id);
        await i.reply({ content: '❌ Order dibatalkan.', ephemeral: true });
        return;
      }
      if (i.customId.startsWith('payment_approve_')) {
        if (!isAdmin(i)) { await i.reply({ content: '❌ Hanya admin.', ephemeral: true }); return; }
        await handlePaymentApprove(i);
        return;
      }
      if (i.customId.startsWith('payment_reject_')) {
        if (!isAdmin(i)) { await i.reply({ content: '❌ Hanya admin.', ephemeral: true }); return; }
        await handlePaymentReject(i);
        return;
      }
      if (i.customId.startsWith('refill_request_')) { await handleRefillRequest(i); return; }
      if (i.customId.startsWith('ticket_close_'))   { await handleTicketClose(i);   return; }
      return;
    }

    if (interaction.isModalSubmit()) {
      const i = interaction as ModalSubmitInteraction;
      if (i.customId.startsWith('order_modal_')) { await handleOrderModal(i); return; }
      return;
    }

  } catch (err: any) {
    logger.error('[Interaction] Unhandled error', { error: err.message });
    try {
      const reply = { content: '❌ Terjadi kesalahan, coba lagi.', ephemeral: true };
      if ('replied' in interaction && (interaction as any).replied) return;
      if ('deferred' in interaction && (interaction as any).deferred) {
        await (interaction as any).editReply(reply);
      } else {
        await (interaction as any).reply(reply);
      }
    } catch (_) {}
  }
}
