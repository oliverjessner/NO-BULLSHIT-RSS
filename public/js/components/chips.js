export function createTopicChip(topic, { digest = false, activeSlug = '' } = {}) {
    const slug = String(topic?.slug || '').trim().toLowerCase();
    const label = String(topic?.label || slug || 'topic');
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = digest ? 'digest-topic-chip oj-tag' : 'article-topic-chip oj-tag';
    chip.textContent = label;
    chip.title = topic?.score == null ? (slug || label) : `${label} (${Number(topic.score || 0).toFixed(2)})`;
    chip.dataset.action = 'filter-topic';
    if (slug) {
        chip.dataset.topicSlug = slug;
        chip.classList.toggle('is-active', slug === activeSlug);
        chip.setAttribute('aria-pressed', String(slug === activeSlug));
        if (digest) chip.classList.add('is-clickable');
    } else {
        chip.disabled = true;
    }
    return chip;
}

export function createSourceChip({ name = 'Unknown source', logo = '', feedId = null } = {}, { digest = true } = {}) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = digest
        ? 'digest-source-chip is-clickable oj-tag'
        : 'meta-source digest-source-chip is-clickable oj-tag';
    chip.dataset.action = 'filter-source';
    chip.dataset.sourceName = name;
    chip.setAttribute('aria-label', `Filter feed by ${name}`);
    if (feedId) chip.dataset.feedId = String(feedId);
    if (logo) {
        const image = document.createElement('img');
        image.className = digest ? 'digest-source-logo' : 'source-logo digest-source-logo';
        image.src = logo;
        image.alt = '';
        chip.appendChild(image);
    }
    const text = document.createElement('span');
    text.className = digest ? 'digest-source-name' : 'source-name digest-source-name';
    text.textContent = name;
    chip.appendChild(text);
    return chip;
}

export function collectTopics(items) {
    const topics = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        for (const topic of Array.isArray(item?.topics) ? item.topics : []) {
            const slug = String(topic?.slug || '').trim().toLowerCase();
            const label = String(topic?.label || slug).trim();
            const key = slug || label.toLowerCase();
            const score = Number(topic?.score || 0);
            if (label && (!topics.has(key) || score > topics.get(key).score)) topics.set(key, { slug, label, score });
        }
    }
    return [...topics.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}
