let source = null;

export function initEvents(handlers = {}) {
    if (source) return;
    source = new EventSource('/api/events');
    source.addEventListener('update', event => {
        try {
            const payload = JSON.parse(event.data || '{}');
            const name = payload.event || '';
            if (name === 'watchdogs.updated' || name === 'connected') handlers.watchdogsUpdated?.(payload.data);
            else if (name === 'fetch.completed') handlers.fetchCompleted?.(payload.data);
            else if (name === 'feeds.updated') handlers.feedsUpdated?.(payload.data);
            else if (name === 'lists.updated') handlers.listsUpdated?.(payload.data);
            else if (name === 'lists.items.updated') handlers.listItemsUpdated?.(payload.data);
            else if (name === 'topics.updated' || name === 'topics.reprocessed') handlers.topicsUpdated?.(payload.data);
            else if (name === 'digest.settings.updated') handlers.digestSettingsUpdated?.(payload.data);
            else if (name === 'bullshit-rules.updated') handlers.bullshitRulesUpdated?.(payload.data);
            else if (name === 'articles.updated' || name.startsWith('webhook.')) handlers.articlesUpdated?.(payload.data);
        } catch {
            // Ignore malformed events; the next valid event can still refresh the UI.
        }
    });
}

export function closeEvents() {
    source?.close();
    source = null;
}
