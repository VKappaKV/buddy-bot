import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions, type Request } from 'miniflare';
import { afterAll, beforeAll, describe, test } from 'vitest';

const telegramUser = {
  id: 2718,
  is_bot: false,
  first_name: 'Tester',
  username: 'local_tester',
};
const botUser = { id: 12345, is_bot: true, first_name: 'Buddy', username: 'buddy_test_bot' };
const whatsappUser = '15550100001';
const telegramSecret = 'local-telegram-test-secret';
const whatsappSecret = 'local-whatsapp-test-secret';
const whatsappVerify = 'local-whatsapp-verification';
const telegramPair = 'buddy-local-telegram-pair';
const whatsappPair = 'buddy-local-whatsapp-pair';
const audio = Buffer.from('OggS local test fixture');
const schema = await readFile(new URL('../migrations/0001_diary.sql', import.meta.url), 'utf8');

type Channel = 'telegram' | 'whatsapp';
type DiaryRow = {
  channel: Channel;
  message_id: string;
  owner: string;
  text: string;
  audio_key: string | null;
  audio_bytes: number | null;
  receipt: 'pending' | 'sending' | 'sent' | 'unknown';
};

type TelegramReply = { chat_id: string | number; text: string; reply_parameters?: { message_id: number } };
type WhatsAppReply = { to: string; text: { body: string }; context?: { message_id: string } };

function telegram(id: number, text: string | null, owner = telegramUser) {
  return {
    update_id: id + 1000,
    message: {
      message_id: id,
      date: 1795431600,
      from: owner,
      chat: { id: owner.id, type: 'private', first_name: owner.first_name },
      ...(text === null
        ? {
            voice: {
              file_id: 'telegram-voice',
              file_unique_id: 'telegram-audio-id',
              duration: 1,
              mime_type: 'audio/ogg',
              file_size: audio.length,
            },
          }
        : { text }),
    },
  };
}

function whatsappMessage(id: number, text: string | null, owner: string) {
  return {
    id: 'wamid.' + id,
    timestamp: '1795431600',
    from: owner,
    ...(text === null
      ? { type: 'audio', audio: { id: 'whatsapp-voice', mime_type: 'audio/ogg', voice: true } }
      : { type: 'text', text: { body: text } }),
  };
}

function whatsapp(id: number, text: string | null, owner = whatsappUser) {
  return whatsappBatch([whatsappMessage(id, text, owner)], owner);
}

function whatsappBatch(messages: ReturnType<typeof whatsappMessage>[], owner = whatsappUser) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'fake-business',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100100', phone_number_id: '9001' },
              contacts: [{ wa_id: owner, profile: { name: 'Tester' } }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

function deliver(runtime: Miniflare, channel: Channel, event: object, signed = true) {
  const body = JSON.stringify(event);
  const authentication: Record<string, string> =
    channel === 'telegram'
      ? { 'x-telegram-bot-api-secret-token': signed ? telegramSecret : 'wrong' }
      : {
          'x-hub-signature-256':
            'sha256=' +
            createHmac('sha256', signed ? whatsappSecret : 'wrong')
              .update(body)
              .digest('hex'),
        };
  return runtime.dispatchFetch('http://localhost/webhooks/' + channel, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...authentication },
  });
}

describe('Chat SDK 4.45.0 su Cloudflare Workers locale', { concurrent: false, shuffle: false }, () => {
  const confirmations: { channel: Channel; id: string }[] = [];
  const fakeErrors: unknown[] = [];
  let failMedia = false;
  let failConfirmation = false;
  let storage: Awaited<ReturnType<typeof mkdtempDisposable>>;
  let options: MiniflareOptions;
  let runtime: Miniflare;
  let database: Awaited<ReturnType<Miniflare['getD1Database']>>;

  beforeAll(async () => {
    storage = await mkdtempDisposable(join(tmpdir(), 'buddy-chat-'));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'node'],
      plugins: [
        {
          name: 'workers-node-imports',
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, (args) => {
              if (isBuiltin(args.path)) {
                const path = args.path.startsWith('node:') ? args.path : 'node:' + args.path;
                return { path, external: true };
              }
            });
          },
        },
      ],
    });

    options = {
      host: '127.0.0.1',
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'buddy-prototype' },
      d1Persist: join(storage.path, 'd1'),
      r2Buckets: { AUDIO: 'buddy-prototype-audio' },
      r2Persist: join(storage.path, 'r2'),
      bindings: {
        TELEGRAM_PAIR_CODE: telegramPair,
        WHATSAPP_PAIR_CODE: whatsappPair,
        TELEGRAM_TOKEN: '12345:fake',
        TELEGRAM_API_URL: 'https://telegram.test',
        WHATSAPP_ACCESS_TOKEN: 'fake',
        WHATSAPP_PHONE_NUMBER_ID: '9001',
        WHATSAPP_API_URL: 'https://whatsapp.test',
        TELEGRAM_WEBHOOK_SECRET: telegramSecret,
        WHATSAPP_APP_SECRET: whatsappSecret,
        WHATSAPP_VERIFY_TOKEN: whatsappVerify,
      },
      async outboundService(request: Request, runtime: Miniflare) {
        const { hostname, pathname } = new URL(request.url);
        try {
          if (hostname === 'telegram.test') {
            if (pathname.endsWith('/getMe')) return Response.json({ ok: true, result: botUser });
            if (pathname.endsWith('/sendChatAction')) return Response.json({ ok: true, result: true });
            if (pathname.endsWith('/getFile')) {
              return Response.json({
                ok: true,
                result: { file_id: 'telegram-voice', file_path: 'voice/probe.ogg' },
              });
            }
            if (pathname.endsWith('/voice/probe.ogg')) {
              await setTimeout(30);
              return failMedia
                ? new Response(null, { status: 503 })
                : new Response(audio, { headers: { 'content-type': 'audio/ogg' } });
            }
            if (pathname.endsWith('/sendMessage')) {
              const input = (await request.json()) as TelegramReply;
              assert.equal(String(input.chat_id), String(telegramUser.id));
              if (input.text === 'Canale di test collegato.') {
                await verifyPairing(runtime, 'telegram', String(telegramUser.id));
              } else {
                assert.ok(input.reply_parameters, 'Telegram must reply to the original message');
                await verifyAtConfirmation(
                  runtime,
                  'telegram',
                  telegramUser.id + ':' + input.reply_parameters.message_id,
                  input.text,
                );
              }
              if (failConfirmation)
                return Response.json({ ok: false, description: 'Simulated outage' }, { status: 502 });
              return Response.json({
                ok: true,
                result: {
                  message_id: 10_000 + confirmations.length,
                  date: 1795431600,
                  from: botUser,
                  text: input.text,
                  chat: { id: telegramUser.id, type: 'private', first_name: telegramUser.first_name },
                },
              });
            }
          }
          if (hostname === 'whatsapp.test') {
            if (pathname.endsWith('/whatsapp-voice'))
              return Response.json({ url: 'https://whatsapp.test/media/probe.ogg' });
            if (pathname === '/media/probe.ogg') {
              await setTimeout(30);
              return failMedia
                ? new Response(null, { status: 503 })
                : new Response(audio, { headers: { 'content-type': 'audio/ogg' } });
            }
            if (pathname.endsWith('/9001/messages')) {
              const input = (await request.json()) as WhatsAppReply;
              assert.equal(input.to, whatsappUser);
              if (input.text.body === 'Canale di test collegato.') {
                await verifyPairing(runtime, 'whatsapp', whatsappUser);
              } else {
                assert.ok(input.context, 'WhatsApp must reply to the original message');
                await verifyAtConfirmation(runtime, 'whatsapp', input.context.message_id, input.text.body);
              }
              return Response.json({
                messaging_product: 'whatsapp',
                messages: [{ id: 'wamid.reply-' + confirmations.length }],
              });
            }
          }
          assert.fail('Unexpected fake API request: ' + hostname + pathname);
        } catch (error) {
          fakeErrors.push(error);
          return new Response(null, { status: 500 });
        }
      },
    };

    runtime = new Miniflare(options);
    database = await runtime.getD1Database('DB');
    for (const statement of schema
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean))
      await database.prepare(statement).run();
  }, 60_000);

  afterAll(async () => {
    try {
      await runtime?.dispose();
    } finally {
      await storage?.remove();
    }
  });

  async function verifyPairing(runtime: Miniflare, channel: Channel, user: string) {
    const database = await runtime.getD1Database('DB');
    const owner = await database
      .prepare('SELECT user_id FROM test_owners WHERE channel=?')
      .bind(channel)
      .first<string>('user_id');
    assert.equal(owner, user);
  }

  async function verifyAtConfirmation(runtime: Miniflare, channel: Channel, id: string, text: string) {
    const database = await runtime.getD1Database('DB');
    const row = await database
      .prepare('SELECT * FROM diary WHERE channel=? AND message_id=?')
      .bind(channel, id)
      .first<DiaryRow>();
    assert.ok(row, 'D1 must already contain the message');
    assert.equal(row.receipt, 'sending');
    assert.equal(row.owner, 'owner');
    assert.equal(text, row.audio_key ? 'Vocale salvato.' : 'Annotazione salvata.');
    if (row.audio_key) {
      const bucket = await runtime.getR2Bucket('AUDIO');
      const object = await bucket.get(row.audio_key);
      assert.ok(object, 'R2 must already contain the voice attachment');
      assert.deepEqual(Buffer.from(await object.arrayBuffer()), audio);
    }
    confirmations.push({ channel, id });
  }

  const entries = async () =>
    (await database.prepare('SELECT * FROM diary ORDER BY channel,message_id').all<DiaryRow>()).results;

  test('verifica webhook e limita la raccolta al proprietario', async () => {
    const challenge = await runtime.dispatchFetch(
      'http://localhost/webhooks/whatsapp?' +
        new URLSearchParams({
          'hub.mode': 'subscribe',
          'hub.verify_token': whatsappVerify,
          'hub.challenge': '123456',
        }),
    );
    assert.equal(await challenge.text(), '123456');
    assert.equal((await deliver(runtime, 'telegram', telegram(1, 'ignorato'), false)).status, 401);
    assert.equal((await deliver(runtime, 'whatsapp', whatsapp(1, 'ignorato'), false)).status, 401);
    assert.equal(
      (await deliver(runtime, 'telegram', telegram(2, 'altro utente', { ...telegramUser, id: 123 }))).status,
      200,
    );
    assert.equal(
      (await deliver(runtime, 'whatsapp', whatsapp(2, 'altro utente', '15550100002'))).status,
      200,
    );
    assert.deepEqual(await entries(), []);
    assert.deepEqual(confirmations, []);
  });

  test('associa entrambi i canali con il codice e conserva il primo proprietario', async () => {
    assert.equal((await deliver(runtime, 'telegram', telegram(3, telegramPair))).status, 200);
    assert.equal((await deliver(runtime, 'whatsapp', whatsapp(3, whatsappPair))).status, 200);
    assert.equal(
      (await deliver(runtime, 'telegram', telegram(4, telegramPair, { ...telegramUser, id: 123 }))).status,
      200,
    );
    assert.equal((await deliver(runtime, 'whatsapp', whatsapp(4, whatsappPair, '15550100002'))).status, 200);
    await verifyPairing(runtime, 'telegram', String(telegramUser.id));
    await verifyPairing(runtime, 'whatsapp', whatsappUser);
    assert.deepEqual(await entries(), []);
    assert.deepEqual(fakeErrors, []);
  });

  test('testo e vocali da entrambi i canali, con risposta solo dopo la scrittura', async () => {
    const responses = await Promise.all([
      deliver(runtime, 'telegram', telegram(10, 'Testo Telegram')),
      deliver(runtime, 'telegram', telegram(11, null)),
      deliver(runtime, 'whatsapp', whatsapp(10, 'Testo WhatsApp')),
      deliver(runtime, 'whatsapp', whatsapp(11, null)),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200, 200],
    );
    const rows = await entries();
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((row) => row.receipt === 'sent').length, 4);
    assert.equal(rows.filter((row) => row.audio_key).length, 2);
    assert.equal(confirmations.length, 4);
    assert.deepEqual(fakeErrors, []);
  });

  test('riconsegne, raffiche e testi identici con ID distinti', async () => {
    const telegramOne = telegram(20, 'stesso testo');
    const whatsappOne = whatsapp(20, 'stesso testo');
    const started = confirmations.length;
    const responses = await Promise.all([
      deliver(runtime, 'telegram', telegramOne),
      deliver(runtime, 'telegram', telegramOne),
      deliver(runtime, 'telegram', telegram(21, 'stesso testo')),
      deliver(runtime, 'whatsapp', whatsappOne),
      deliver(runtime, 'whatsapp', whatsappOne),
      deliver(
        runtime,
        'whatsapp',
        whatsappBatch([
          whatsappMessage(21, 'stesso testo', whatsappUser),
          whatsappMessage(22, 'stesso testo', whatsappUser),
        ]),
      ),
    ]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal((await entries()).filter((row) => row.text === 'stesso testo').length, 5);
    assert.equal(confirmations.length - started, 5);
    assert.deepEqual(fakeErrors, []);
  });

  test('errore D1 e riconsegna su entrambi i canali', async () => {
    await database
      .prepare(`CREATE TRIGGER reject_test_text BEFORE INSERT ON diary
        WHEN NEW.text = 'guasto D1' BEGIN SELECT RAISE(ABORT, 'guasto simulato'); END`)
      .run();
    const before = confirmations.length;
    const requests = [
      ['telegram', telegram(30, 'guasto D1')],
      ['whatsapp', whatsapp(30, 'guasto D1')],
    ] as const;
    try {
      for (const [channel, event] of requests)
        assert.equal((await deliver(runtime, channel, event)).status, 503);
      assert.equal(confirmations.length, before);
      assert.ok((await entries()).every((row) => row.text !== 'guasto D1'));
    } finally {
      await database.prepare('DROP TRIGGER reject_test_text').run();
    }
    for (const [channel, event] of requests)
      assert.equal((await deliver(runtime, channel, event)).status, 200);
    assert.equal(confirmations.length, before + 2);
  });

  test('vocale indisponibile e recupero con riconsegna', async () => {
    const before = confirmations.length;
    const requests = [
      ['telegram', telegram(40, null)],
      ['whatsapp', whatsapp(40, null)],
    ] as const;
    failMedia = true;
    try {
      for (const [channel, event] of requests)
        assert.equal((await deliver(runtime, channel, event)).status, 503);
      assert.equal(confirmations.length, before);
      assert.ok((await entries()).every((row) => !row.message_id.endsWith('40')));
    } finally {
      failMedia = false;
    }
    for (const [channel, event] of requests)
      assert.equal((await deliver(runtime, channel, event)).status, 200);
    assert.equal(confirmations.length, before + 2);
  });

  test('conferma incerta con fonte già acquisita', async () => {
    const event = telegram(50, 'conferma incerta');
    const before = confirmations.length;
    failConfirmation = true;
    try {
      assert.equal((await deliver(runtime, 'telegram', event)).status, 200);
    } finally {
      failConfirmation = false;
    }
    assert.equal((await entries()).find((row) => row.text === 'conferma incerta')?.receipt, 'unknown');
    assert.equal((await deliver(runtime, 'telegram', event)).status, 200);
    assert.equal(confirmations.length, before + 1);
  });

  test('riavvio del runtime e replay senza nuove conferme', async () => {
    const before = confirmations.length;
    const originals = await entries();
    await runtime.dispose();
    runtime = new Miniflare(options);
    database = await runtime.getD1Database('DB');
    assert.deepEqual(await entries(), originals);
    const bucket = await runtime.getR2Bucket('AUDIO');
    assert.equal((await bucket.list()).objects.length, 4);
    assert.equal((await deliver(runtime, 'telegram', telegram(11, null))).status, 200);
    assert.equal((await deliver(runtime, 'whatsapp', whatsapp(11, null))).status, 200);
    assert.equal(confirmations.length, before);
    assert.deepEqual(fakeErrors, []);
  });
});
