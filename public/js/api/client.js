export async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = body;
        throw error;
    }
    return response.status === 204 ? null : response.json();
}

const json = (method, body, signal) => ({ method, body: JSON.stringify(body), signal });
export const api = Object.freeze({
    watchdogs: () => apiFetch('/api/watchdogs'),
    createWatchdog: body => apiFetch('/api/watchdogs', json('POST', body)),
    updateWatchdog: (id, body) => apiFetch(`/api/watchdogs/${id}`, json('PATCH', body)),
    deleteWatchdog: id => apiFetch(`/api/watchdogs/${id}`, { method: 'DELETE' }),
    watchdogMatches: params => apiFetch(`/api/watchdogs/matches?${params}`),
    watchdogExport: params => apiFetch(`/api/watchdogs/export?${params}`),
    watchdogMatch: id => apiFetch(`/api/watchdogs/matches/${id}`),
    updateWatchdogMatch: (id, body) => apiFetch(`/api/watchdogs/matches/${id}`, json('PATCH', body)),
    watchdogNotifications: () => apiFetch('/api/watchdogs/notifications'),
    setWatchdogNotifications: enabled => apiFetch('/api/watchdogs/notifications', json('PATCH', { enabled })),
    feeds: () => apiFetch('/api/feeds'),
    createFeed: body => apiFetch('/api/feeds', json('POST', body)),
    updateFeed: (id, body) => apiFetch(`/api/feeds/${id}`, json('PUT', body)),
    deleteFeed: id => apiFetch(`/api/feeds/${id}`, { method: 'DELETE' }),
    testFeed: url => apiFetch(`/api/feeds/test/url?url=${encodeURIComponent(url)}`),
    lists: () => apiFetch('/api/lists'),
    createList: body => apiFetch('/api/lists', json('POST', body)),
    updateList: (id, body) => apiFetch(`/api/lists/${id}`, json('PUT', body)),
    deleteList: id => apiFetch(`/api/lists/${id}`, { method: 'DELETE' }),
    articleLists: ids => apiFetch('/api/articles/lists/bulk', json('POST', { articleIds: ids })),
    addToList: (listId, ids) => apiFetch(`/api/lists/${listId}/items/bulk`, json('POST', { articleIds: ids })),
    removeFromList: (listId, ids) => apiFetch(`/api/lists/${listId}/items/bulk-delete`, json('POST', { articleIds: ids })),
    topics: () => apiFetch('/api/topics'),
    topicRules: () => apiFetch('/api/topics/rules'),
    createTopic: body => apiFetch('/api/topics', json('POST', body)),
    updateTopic: (slug, body) => apiFetch(`/api/topics/${encodeURIComponent(slug)}`, json('PUT', body)),
    deleteTopic: slug => apiFetch(`/api/topics/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
    validateTopics: source => apiFetch('/api/topics/validate', json('POST', { json: source })),
    saveTopicRules: source => apiFetch('/api/topics/rules', json('PUT', { json: source })),
    reprocessTopics: () => apiFetch('/api/topics/reprocess', { method: 'POST' }),
    bullshitRules: () => apiFetch('/api/bullshit-rules'),
    createBullshitRule: body => apiFetch('/api/bullshit-rules', json('POST', body)),
    updateBullshitRule: (id, body) => apiFetch(`/api/bullshit-rules/${id}`, json('PATCH', body)),
    deleteBullshitRule: id => apiFetch(`/api/bullshit-rules/${id}`, { method: 'DELETE' }),
    reevaluateBullshitRules: () => apiFetch('/api/bullshit-rules/re-evaluate', { method: 'POST' }),
    articles: (params, signal) => apiFetch(`/api/articles?${params}`, { signal }),
    importArticles: urls => apiFetch('/api/articles/import', json('POST', { urls })),
    articleStats: () => apiFetch('/api/articles/stats'),
    statistics: signal => apiFetch('/api/articles/statistics', { signal }),
    dismissArticle: (id, dismissed) => apiFetch(`/api/articles/${id}/dismissed`, json('PATCH', { dismissed })),
    digest: (range, signal) => apiFetch(`/api/articles/digest?${new URLSearchParams({ variant: range })}`, { signal }),
    rankings: (medium = 'golem', signal) => apiFetch(`/api/rankings?${new URLSearchParams({ medium })}`, { signal }),
    refreshRankings: (medium = 'golem') => apiFetch('/api/rankings/refresh', json('POST', { medium })),
    startRankingsAccess: (medium = 'golem') => apiFetch('/api/rankings/access/start', json('POST', { medium })),
    confirmRankingsAccess: (medium, jobId) => apiFetch('/api/rankings/access/confirm', json('POST', { medium, jobId })),
    cancelRankingsAccess: (medium, jobId) => apiFetch('/api/rankings/access/cancel', json('POST', { medium, jobId })),
    forgetRankingsAccess: (medium = 'golem') => apiFetch(`/api/rankings/access?${new URLSearchParams({ medium })}`, { method: 'DELETE' }),
    markDigested: (ids, variant = 'day') => apiFetch('/api/articles/digest/state', json('POST', { articleIds: ids, variant, completed: true })),
    restoreDigested: (ids, variant = 'day') => apiFetch('/api/articles/digest/state', json('POST', { articleIds: ids, variant, completed: false })),
    digestSettings: () => apiFetch('/api/digest-settings'),
    setFeedExcluded: (id, excluded) => apiFetch(`/api/digest-settings/excluded-feeds/${id}`, json('PATCH', { excluded })),
    fetchStatus: () => apiFetch('/api/fetch/status'),
    runFetch: () => apiFetch('/api/fetch/run', { method: 'POST' }),
});
