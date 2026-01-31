const URL_PATTERN = /^https?:\/\//i;

export function isValidUrl(value) {
  if (!value || typeof value !== 'string') return false;
  if (!URL_PATTERN.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export async function checkUrlReachable(url, { timeoutMs = 7000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
