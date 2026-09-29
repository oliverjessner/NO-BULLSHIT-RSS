import { STORAGE_KEYS } from '../config.js';

function readStorage(key, fallback) {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

export const store = {
    reference: {
        feeds: [],
        feedsById: new Map(),
        lists: [],
        listsById: new Map(),
        topics: [],
        topicsBySlug: new Map(),
        bullshitRules: [],
        bullshitRulesById: new Map(),
        digestSettings: { excludedFeedIds: [], blockedWords: [] },
    },
    feed: {
        articles: [],
        articlesById: new Map(),
        requestId: 0,
        requestController: null,
        requestKey: '',
        fingerprint: '',
        hasMore: false,
        loadingMore: false,
        focusedArticleId: null,
        needsRefresh: true,
        initialized: false,
    },
    digest: {
        payload: null,
        articlesById: new Map(),
        requestId: 0,
        requestController: null,
        fingerprint: '',
        needsRefresh: true,
        initialized: false,
        pendingMutationEvents: 0,
        renderedCount: 0,
    },
    settings: {
        initialized: false,
        feedEditingId: null,
        listEditingId: null,
        topicEditingSlug: null,
        bullshitRuleEditingId: null,
    },
    ui: {
        activeView: 'main',
        listLayout: readStorage(STORAGE_KEYS.layout, 'cards') === 'list',
        digestSort: readStorage(STORAGE_KEYS.digestSort, 'desc') === 'asc' ? 'asc' : 'desc',
        digestRange: ['day', 'week', 'month'].includes(readStorage(STORAGE_KEYS.digestRange, 'day'))
            ? readStorage(STORAGE_KEYS.digestRange, 'day')
            : 'day',
        viewerWidth: ['35', '50'].includes(readStorage(STORAGE_KEYS.viewerWidth, '50'))
            ? readStorage(STORAGE_KEYS.viewerWidth, '50')
            : '50',
    },
};

export function setFeeds(feeds) {
    store.reference.feeds = Array.isArray(feeds) ? feeds : [];
    store.reference.feedsById = new Map(store.reference.feeds.map(feed => [Number(feed.id), feed]));
}

export function setLists(lists) {
    store.reference.lists = Array.isArray(lists) ? lists : [];
    store.reference.listsById = new Map(store.reference.lists.map(list => [Number(list.id), list]));
}

export function setTopics(topics) {
    store.reference.topics = Array.isArray(topics) ? topics : [];
    store.reference.topicsBySlug = new Map(store.reference.topics.map(topic => [String(topic.slug), topic]));
}

export function setBullshitRules(rules) {
    store.reference.bullshitRules = Array.isArray(rules) ? rules : [];
    store.reference.bullshitRulesById = new Map(store.reference.bullshitRules.map(rule => [Number(rule.id), rule]));
}

export function setDigestSettings(settings) {
    store.reference.digestSettings = {
        excludedFeedIds: Array.isArray(settings?.excludedFeedIds) ? settings.excludedFeedIds.map(Number) : [],
        blockedWords: Array.isArray(settings?.blockedWords) ? settings.blockedWords : [],
    };
}
