const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4
});

export function renderBuyAlert({ coin, event, trending }) {
  const emoji = coin.emoji || '🟢';
  const buyer = event.buyer ? shortWallet(event.buyer) : 'Fresh buyer';
  const tokens = number.format(Number(event.tokenAmount ?? 0));
  const usdValue = money.format(Number(event.usdValue ?? 0));
  const quoteAmount = event.quoteAmount ? `${number.format(Number(event.quoteAmount))} ${event.quoteSymbol ?? ''}`.trim() : null;
  const chartLine = event.txUrl ? `<a href="${escapeHtml(event.txUrl)}">View transaction</a>` : '';
  const buyLine = coin.buyUrl ? `<a href="${escapeHtml(coin.buyUrl)}">Buy $${escapeHtml(coin.symbol)}</a>` : '';

  return [
    `${emoji} <b>$${escapeHtml(coin.symbol)} Buy!</b>`,
    '',
    `<b>${escapeHtml(buyer)}</b> bought <b>${escapeHtml(tokens)} $${escapeHtml(coin.symbol)}</b>`,
    `Value: <b>${escapeHtml(usdValue)}</b>${quoteAmount ? ` (${escapeHtml(quoteAmount)})` : ''}`,
    event.marketCap ? `Market cap: <b>${escapeHtml(money.format(Number(event.marketCap)))}</b>` : null,
    '',
    [buyLine, chartLine].filter(Boolean).join(' | '),
    renderTrendingBlock(trending, coin.symbol)
  ].filter(Boolean).join('\n');
}

export function renderTrendingBlock(trending, currentSymbol) {
  const items = trending.filter((item) => item.symbol !== currentSymbol.toUpperCase()).slice(0, 4);
  if (items.length === 0) return '';

  return [
    '',
    '<b>Trending with this bot</b>',
    ...items.map((item, index) => {
      const coin = item.coin;
      const link = coin.buyUrl ? ` - <a href="${escapeHtml(coin.buyUrl)}">buy</a>` : '';
      return `${index + 1}. $${escapeHtml(item.symbol)} (${item.buys} buys)${link}`;
    })
  ].join('\n');
}

export function renderCoinList(coins) {
  if (coins.length === 0) return 'No coins are registered yet.';

  return coins.map((coin) => {
    const primary = coin.isPrimary ? ' ⭐' : '';
    const channels = (coin.channels ?? []).length;
    return `$${coin.symbol}${primary} - ${coin.name} (${channels} channel${channels === 1 ? '' : 's'})`;
  }).join('\n');
}

function shortWallet(wallet) {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
