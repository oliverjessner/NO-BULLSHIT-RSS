// Mutations go through the running app, preserving validation and UI events.
export async function writeWatchdog(command, { env = process.env, fetchApi = fetch } = {}) {
    const base = new URL(env.NBS_API_URL || `http://127.0.0.1:${env.PORT || 1377}`);
    if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
        || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new Error('NBS_API_URL must be a loopback HTTP origin, for example http://127.0.0.1:1377.');
    }
    let response;
    try {
        response = await fetchApi(new URL(`/api/watchdogs${command.path}`, base), {
            method: command.method, redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { 'Content-Type': 'application/json' },
            ...(command.body === undefined ? {} : { body: JSON.stringify(command.body) }),
        });
    } catch (error) { throw new Error(`Cannot reach the running app at ${base.origin}: ${error.message}`); }
    const result = response.status === 204 ? { deleted: true } : await response.json();
    if (!response.ok) throw new Error(result?.error || `Watchdog API returned HTTP ${response.status}`);
    return result;
}
