export function logInfo(message, meta = {}) {
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[INFO] ${message}${suffix}`);
}

export function logWarn(message, meta = {}) {
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.warn(`[WARN] ${message}${suffix}`);
}

export function logError(message, meta = {}) {
  const suffix = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  console.error(`[ERROR] ${message}${suffix}`);
}
