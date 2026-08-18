import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import type { Database } from '@/db/client';
import { notifications } from '@/db/schema';
import { loadEnv } from '@/config/env';
import { buildMessage } from './message';
import type { NotificationPayload, Notifier } from './notification.types';

const API_BASE = 'https://api.telegram.org';

@Injectable()
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  private readonly logger = new Logger(TelegramNotifier.name);
  private readonly token: string | undefined;

  constructor(@Inject('DATABASE') private readonly db: Database) {
    this.token = loadEnv().TELEGRAM_BOT_TOKEN;
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  /**
   * One notification per physical unit per profile, enforced by the unique index on
   * `(profile_id, fingerprint)` rather than by application logic.
   *
   * The row is claimed *before* the message goes out. A crash between claim and send loses
   * one notification; doing it the other way round would risk sending the same listing
   * twice on every restart, which is the failure mode that makes a monitor unusable.
   */
  async send(payload: NotificationPayload): Promise<{ messageId: string | null }> {
    const claimed = await this.claim(payload);
    if (!claimed) {
      this.logger.debug(`already notified ${payload.profileId} about ${payload.fingerprint.slice(0, 12)}`);
      return { messageId: null };
    }

    if (!this.token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN unset — notification recorded but not sent');
      return { messageId: null };
    }

    const text = buildMessage(payload);
    const messageIds: string[] = [];
    const failures: string[] = [];

    for (const chatId of payload.chatIds) {
      const messageId = await this.sendTo(chatId, text);
      if (messageId === null) {
        failures.push(chatId);
        continue;
      }
      messageIds.push(messageId);
      if (payload.includeMap) await this.sendPin(payload, chatId, messageId);
    }

    // Partial failure keeps the claim. Releasing it would re-send the listing to everyone
    // next cycle, including the people who already read it — a worse outcome than one
    // recipient missing a message they can still find in the others' chat.
    if (messageIds.length === 0) {
      await this.release(payload);
      this.logger.error(`could not deliver ${payload.fingerprint.slice(0, 12)} to any recipient`);
      return { messageId: null };
    }
    if (failures.length > 0) {
      this.logger.warn(`delivered to ${messageIds.length}/${payload.chatIds.length}; failed: ${failures.join(', ')}`);
    }

    await this.recordMessageIds(payload, messageIds);
    return { messageId: messageIds[0] ?? null };
  }

  /**
   * An operational message — not a listing, so it never touches the notifications table and
   * is never deduplicated by fingerprint.
   */
  async alert(chatIds: string[], text: string): Promise<void> {
    if (!this.token) {
      this.logger.warn(`alert not sent (no token): ${text.replace(/<[^>]+>/g, '')}`);
      return;
    }
    for (const chatId of chatIds) await this.sendTo(chatId, text);
  }

  /** One recipient. Returns the message id, or null when Telegram refused. */
  private async sendTo(chatId: string, text: string): Promise<string | null> {
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; result?: { message_id?: number }; description?: string };
      if (!body.ok) {
        this.logger.error(`Telegram rejected the message for ${chatId}: ${body.description ?? res.status}`);
        return null;
      }
      return body.result?.message_id ? String(body.result.message_id) : null;
    } catch (err) {
      this.logger.error(`Telegram send to ${chatId} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A native location pin, sent as a reply so the two messages stay grouped in the chat.
   *
   * Telegram renders it as a real, interactive map: one tap opens the neighbourhood, street
   * view and walking directions. A static image pasted into the message could not do any of
   * that, which is why this beats generating one.
   *
   * Failure here never releases the claim. The notification itself already went out, and
   * re-sending the whole listing tomorrow because a pin failed would be worse than a
   * missing pin.
   */
  private async sendPin(payload: NotificationPayload, chatId: string, replyTo: string | null): Promise<void> {
    const { lat, lng, address, title } = payload.listing;
    if (lat === null || lng === null || !this.token) return;

    // sendVenue labels the pin; without an address Telegram requires plain sendLocation.
    const useVenue = Boolean(address);
    const method = useVenue ? 'sendVenue' : 'sendLocation';
    const body: Record<string, unknown> = {
      chat_id: chatId,
      latitude: lat,
      longitude: lng,
      disable_notification: true,
    };
    if (useVenue) {
      body.title = title.slice(0, 90);
      body.address = address;
    }
    if (replyTo) body.reply_to_message_id = Number(replyTo);

    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { ok?: boolean; description?: string };
      if (!parsed.ok) {
        this.logger.warn(`location pin rejected for ${payload.listing.sourceId}: ${parsed.description ?? res.status}`);
      }
    } catch (err) {
      this.logger.warn(`location pin failed for ${payload.listing.sourceId}: ${(err as Error).message}`);
    }
  }

  /** Returns false when this unit was already notified for this profile. */
  private async claim(payload: NotificationPayload): Promise<boolean> {
    const inserted = await this.db
      .insert(notifications)
      .values({
        profileId: payload.profileId,
        fingerprint: payload.fingerprint,
        listingId: payload.listingId,
        score: payload.score.score,
      })
      .onConflictDoNothing({ target: [notifications.profileId, notifications.fingerprint] })
      .returning({ id: notifications.id });
    return inserted.length > 0;
  }

  private async release(payload: NotificationPayload): Promise<void> {
    await this.db
      .delete(notifications)
      .where(
        and(
          eq(notifications.profileId, payload.profileId),
          eq(notifications.fingerprint, payload.fingerprint),
        ),
      );
  }

  private async recordMessageIds(payload: NotificationPayload, messageIds: string[]): Promise<void> {
    await this.db
      .update(notifications)
      .set({ telegramMessageIds: messageIds })
      .where(
        and(
          eq(notifications.profileId, payload.profileId),
          eq(notifications.fingerprint, payload.fingerprint),
        ),
      );
  }
}
