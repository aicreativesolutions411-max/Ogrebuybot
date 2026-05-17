const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4
});

export function renderBuyAlert({ coin, event, trending, primaryCoin, tokenMeta }) {
  const tag = coin.emoji || '[BUY]';
  const buyer = event.buyer ? shortWallet(event.buyer) : 'Fresh buyer';
  const tokens = number.format(Number(event.tokenAmount ?? 0));
  const usdValue = money.format(Number(event.usdValue ?? 0));
  const quoteAmount = event.quoteAmount ? `${number.format(Number(event.quoteAmount))} ${event.quoteSymbol ?? ''}`.trim() : null;
  const txLine = event.txUrl ? `<a href="${escapeHtml(event.txUrl)}">View transaction</a>` : '';
  const buyLine = coin.buyUrl ? `<a href="${escapeHtml(coin.buyUrl)}">Buy $${escapeHtml(coin.symbol)}</a>` : '';

  return [
    `${escapeHtml(tag)} <b>$${escapeHtml(coin.symbol)} Buy!</b>`,
    '',
    quoteAmount ? `Spent: <b>${escapeHtml(quoteAmount)}</b>` : null,
    `Received: <b>${escapeHtml(tokens)} $${escapeHtml(coin.symbol)}</b>`,
    `USD value: <b>${escapeHtml(usdValue)}</b>`,
    `Buyer: <b>${escapeHtml(buyer)}</b>`,
    event.buyerSolBalance != null ? `Buyer wallet: <b>${escapeHtml(number.format(Number(event.buyerSolBalance)))} SOL</b>` : null,
    event.marketCap ? `Market cap: <b>${escapeHtml(money.format(Number(event.marketCap)))}</b>` : null,
    event.dex ? `DEX: <b>${escapeHtml(event.dex)}</b>` : null,
    renderBondingCurve(tokenMeta),
    '',
    [buyLine, txLine].filter(Boolean).join(' | '),
    renderAdBlock({ trending, currentSymbol: coin.symbol, primaryCoin })
  ].filter(Boolean).join('\n');
}

function renderBondingCurve(tokenMeta) {
  if (!tokenMeta || tokenMeta.complete === true || tokenMeta.bondingProgress == null) return null;

  const progress = Math.max(0, Math.min(100, Number(tokenMeta.bondingProgress)));
  const filled = Math.round(progress / 10);
  const empty = 10 - filled;
  return [
    '',
    '<b>Pump.fun bonding</b>',
    `[${'#'.repeat(filled)}${'-'.repeat(empty)}] ${number.format(progress)}%`
  ].join('\n');
}

export function renderAdBlock({ trending, currentSymbol, primaryCoin }) {
  const lines = ['', '<b>Trending bot channels by 24h volume</b>'];
  const current = currentSymbol.toUpperCase();
  const primary = primaryCoin?.symbol?.toUpperCase();

  if (primaryCoin) {
    const primaryLink = primaryCoin.buyUrl ? ` - <a href="${escapeHtml(primaryCoin.buyUrl)}">buy</a>` : '';
    const label = primary === current ? 'Featured now' : 'Rotating ad';
    lines.push(`${label}: $${escapeHtml(primaryCoin.symbol)}${primaryLink}`);
  }

  const items = trending
    .filter((item) => item.symbol !== primary)
    .slice(0, 4);

  if (items.length === 0) {
    lines.push('More projects using this bot will show here as buys come in.');
    return lines.join('\n');
  }

  for (const item of items) {
    const coin = item.coin;
    const link = coin.buyUrl ? ` - <a href="${escapeHtml(coin.buyUrl)}">buy</a>` : '';
    lines.push(`$${escapeHtml(item.symbol)}: ${money.format(item.volumeUsd)} volume, ${item.buys} buys${link}`);
  }

  return lines.join('\n');
}

export function renderCoinList(coins) {
  if (coins.length === 0) return 'No coins are registered yet.';

  return coins.map((coin) => {
    const primary = coin.isPrimary ? ' *' : '';
    const channels = (coin.channels ?? []).length;
    return `$${coin.symbol}${primary} - ${coin.name} (${channels} channel${channels === 1 ? '' : 's'})`;
  }).join('\n');
}

export function renderTrendingList(trending, primaryCoin) {
  if (trending.length === 0) {
    return primaryCoin
      ? `No buy volume yet. $${primaryCoin.symbol} will still rotate as the featured ad.`
      : 'No buy volume yet.';
  }

  return [
    'Top bot coins by 24h volume:',
    '',
    ...trending.map((item, index) => `${index + 1}. $${item.symbol} - ${money.format(item.volumeUsd)} volume, ${item.buys} buys`)
  ].join('\n');
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
