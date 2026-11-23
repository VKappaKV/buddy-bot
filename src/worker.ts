import { createMemoryState } from '@chat-adapter/state-memory';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createWhatsAppAdapter, WhatsAppAdapter } from '@chat-adapter/whatsapp';
import { Chat, ConsoleLogger } from 'chat';
import { Effect } from 'effect';
import { capture, cloudflareDiary } from './capture.ts';

interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  TELEGRAM_USER?: string;
  TELEGRAM_PAIR_CODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_API_URL?: string;
  WHATSAPP_USER?: string;
  WHATSAPP_PAIR_CODE?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_API_URL?: string;
}

const fakeWhatsAppOrigin = 'https://whatsapp.test';
const logger = new ConsoleLogger('silent');

type MediaTransport = NonNullable<Parameters<WhatsAppAdapter['downloadMedia']>[1]>;

class LocalWhatsAppAdapter extends WhatsAppAdapter {
  override downloadMedia(id: string) {
    // shortcut: use the local fetch mock for media bytes; verify the SDK's default transport on real WhatsApp later.
    return super.downloadMedia(id, async (url, signal, headers) => {
      if (url.origin !== fakeWhatsAppOrigin) throw new Error('Only the fake media host is allowed');
      const response = await fetch(url, {
        signal,
        headers: { ...headers, 'accept-encoding': 'identity' },
        redirect: 'manual',
      });
      const reader = response.body?.getReader();
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        destroy() {
          void reader?.cancel().catch(() => {});
        },
        async *[Symbol.asyncIterator]() {
          if (!reader) return;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) return;
              yield value;
            }
          } finally {
            reader.releaseLock();
          }
        },
      } as Awaited<ReturnType<MediaTransport>>;
    });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const channel =
      path === '/webhooks/telegram' ? 'telegram' : path === '/webhooks/whatsapp' ? 'whatsapp' : null;
    if (!channel) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST' && !(channel === 'whatsapp' && request.method === 'GET')) {
      return new Response('Method not allowed', { status: 405 });
    }

    let adapter;
    if (channel === 'telegram') {
      const token = env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TOKEN;
      if (!token || !env.TELEGRAM_WEBHOOK_SECRET) return new Response(null, { status: 404 });
      const encoder = new TextEncoder();
      const provided = encoder.encode(request.headers.get('x-telegram-bot-api-secret-token') ?? '');
      const expected = encoder.encode(env.TELEGRAM_WEBHOOK_SECRET);
      if (provided.length !== expected.length || !crypto.subtle.timingSafeEqual(provided, expected)) {
        return new Response(null, { status: 401 });
      }
      adapter = createTelegramAdapter({
        botToken: token,
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
        mode: 'webhook',
        apiUrl: env.TELEGRAM_API_URL,
        persistThreadHistory: false,
        logger,
      });
    } else {
      if (
        !env.WHATSAPP_ACCESS_TOKEN ||
        !env.WHATSAPP_APP_SECRET ||
        !env.WHATSAPP_PHONE_NUMBER_ID ||
        !env.WHATSAPP_VERIFY_TOKEN
      ) {
        return new Response(null, { status: 404 });
      }
      const config = {
        accessToken: env.WHATSAPP_ACCESS_TOKEN,
        appSecret: env.WHATSAPP_APP_SECRET,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        apiUrl: env.WHATSAPP_API_URL,
        userName: 'buddy_test_bot',
        logger,
      };
      adapter =
        env.WHATSAPP_API_URL === fakeWhatsAppOrigin
          ? new LocalWhatsAppAdapter(config)
          : createWhatsAppAdapter(config);
    }
    const chat = new Chat({
      userName: 'buddy_test_bot',
      adapters: { [channel]: adapter },
      // shortcut: per-request state makes SDK claims disposable; validate durable SDK state before a deployment.
      state: createMemoryState(),
      concurrency: 'concurrent',
      logger,
    });

    const diary = cloudflareDiary(env.DB, env.AUDIO);
    const policy =
      channel === 'telegram'
        ? { testUser: env.TELEGRAM_USER, pairCode: env.TELEGRAM_PAIR_CODE }
        : { testUser: env.WHATSAPP_USER, pairCode: env.WHATSAPP_PAIR_CODE };
    let persisted = true;
    chat.onDirectMessage(async (thread, message) => {
      if (message.author.isBot || message.metadata.edited) return;
      const audio = message.attachments.find((attachment) => attachment.type === 'audio');
      await Effect.runPromise(
        capture(
          { channel, id: message.id, userId: message.author.userId, text: message.text },
          audio && { size: audio.size, mimeType: audio.mimeType, download: audio.fetchData },
          policy,
          (text) => thread.reply(message, text),
        ).pipe(Effect.provide(diary)),
      );
    });
    const tasks: Promise<unknown>[] = [];
    try {
      const response = await chat.webhooks[channel](request, {
        deduplicate: false,
        propagateHandlerErrors: true,
        waitUntil(task) {
          tasks.push(
            task.catch((error: unknown) => {
              persisted = false;
              if (!env.TELEGRAM_API_URL && !env.WHATSAPP_API_URL) {
                const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
                console.warn('Test capture failed', channel, cause instanceof Error ? cause.name : 'Error');
              }
            }),
          );
        },
      });
      for (const task of tasks) await task;
      return persisted ? response : new Response('Retry delivery', { status: 503 });
    } catch {
      return new Response('Retry delivery', { status: 503 });
    } finally {
      await chat.shutdown();
    }
  },
} satisfies ExportedHandler<Env>;
