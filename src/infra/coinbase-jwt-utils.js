function normalizeCoinbaseJwtUri(method, requestPath) {
  if (!method || !requestPath) return '';
  const verb = String(method).trim().toUpperCase();
  let target = String(requestPath).trim();

  try {
    if (/^https?:\/\//i.test(target)) {
      const u = new URL(target);
      target = `${u.hostname}${u.pathname}${u.search}`;
    }
  } catch (_) {
    // Preserve the original path/query string when parsing fails.
  }

  // Strip off local proxy routing prefixes
  target = target.replace(/^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//i, '');
  target = target.replace(/^\/+/, '');
  target = target.replace(/^coinbase\//i, '');
  target = target.replace(/^\/+/, '');

  if (/^api\.coinbase\.com\//i.test(target) || /^api\.exchange\.coinbase\.com\//i.test(target) || /^api\.pro\.coinbase\.com\//i.test(target)) {
    // Preserve explicit Coinbase host patterns.
  } else if (/^api\/v3\//i.test(target) || /^v3\//i.test(target) || /^brokerage\//i.test(target)) {
    target = `api.coinbase.com/${target}`;
  } else if (!/^[a-z0-9.-]+\/api\/v3\//i.test(target)) {
    target = `api.coinbase.com/${target}`;
  }

  return `${verb} ${target}`;
}

module.exports = {
  normalizeCoinbaseJwtUri,
};
