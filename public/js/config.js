export const CONFIG = Object.freeze({
    ARTICLES_PAGE_SIZE: 50,
    DIGEST_RENDER_BATCH_SIZE: 60,
    SEARCH_DEBOUNCE_MS: 200,
    MAX_WORD_LENGTH: 120,
    MAX_SEARCH_QUERY_LENGTH: 300,
});

export const STORAGE_KEYS = Object.freeze({
    layout: 'fnnd.layout',
    digestSort: 'fnnd.digestSort',
    digestRange: 'fnnd.digestRange',
    viewerWidth: 'fnnd.viewerWidth',
});
