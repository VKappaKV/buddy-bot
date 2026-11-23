const [action, origin] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

async function bot(method, body = {}) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(method + ' rejected (' + response.status + ')');
  return result.result;
}

async function run() {
  if (!token || !['info', 'set', 'clear'].includes(action))
    throw new Error('Provide a test bot token and info, set or clear');
  const webhook = await bot('getWebhookInfo');
  if (action === 'info') {
    const me = await bot('getMe');
    console.log(
      JSON.stringify({
        username: me.username,
        configured: !!webhook.url,
        pending: webhook.pending_update_count,
      }),
    );
    return;
  }
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin ?? ''))
    throw new Error('Expected a temporary trycloudflare.com URL');
  const url = origin + '/webhooks/telegram';
  if (action === 'set') {
    if (!secret) throw new Error('Missing webhook secret');
    if (webhook.url && webhook.url !== url) throw new Error('This bot already uses a different webhook');
    await bot('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] });
  } else if (webhook.url === url) {
    await bot('deleteWebhook');
  }
  const current = await bot('getWebhookInfo');
  if (action === 'set' && current.url !== url) throw new Error('Webhook was not registered');
  if (action === 'clear' && current.url === url) throw new Error('Test webhook still registered');
  console.log(JSON.stringify({ testWebhook: current.url === url, pending: current.pending_update_count }));
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error && error.name === 'Error' ? error.message : 'Telegram request failed');
  process.exitCode = 1;
}
