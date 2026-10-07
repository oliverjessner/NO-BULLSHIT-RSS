import { createTopicChip } from './chips.js';
import { formatDate, formatTriageTime } from '../utils/format.js';
import { hide, show } from '../utils/dom.js';

export function createArticleCard(article, template, activeTopic = '') {
    const fragment = template.content.cloneNode(true);
    const id = Number(article?.id);
    const validId = Number.isInteger(id) && id > 0;
    const card = fragment.querySelector('.card');
    card.dataset.articleId = validId ? String(id) : '';
    card.setAttribute('aria-label', article?.title || 'Untitled article');

    const date = fragment.querySelector('.meta-date');
    date.textContent = formatTriageTime(article?.publishedAt);
    if (article?.publishedAt) {
        date.dateTime = article.publishedAt;
        date.title = formatDate(article.publishedAt);
    }

    if (article?.bullshit) {
        const ruleNames = Array.isArray(article?.bullshitRules) ? article.bullshitRules.filter(Boolean) : [];
        const chip = document.createElement('span');
        chip.className = 'article-bullshit-chip oj-badge oj-badge-danger';
        chip.textContent = 'Bullshit';
        const reasons = ruleNames.length ? `Matched rules:\n- ${ruleNames.join('\n- ')}` : 'Matched by a bullshit rule';
        chip.title = reasons;
        chip.setAttribute('aria-label', reasons.replace(/\n/g, ' '));
        fragment.querySelector('.meta').appendChild(chip);
    }

    const source = fragment.querySelector('.meta-source');
    const sourceLogo = fragment.querySelector('.source-logo');
    fragment.querySelector('.source-name').textContent = article?.sourceName || '—';
    source.dataset.action = 'filter-source';
    source.dataset.sourceName = article?.sourceName || '';
    if (article?.feedId) source.dataset.feedId = String(article.feedId);
    source.disabled = !article?.feedId && !article?.sourceName;
    source.classList.toggle('is-clickable', !source.disabled);
    if (article?.sourceLogoDataUrl) { sourceLogo.src = article.sourceLogoDataUrl; show(sourceLogo); }
    else hide(sourceLogo);

    const title = fragment.querySelector('.article-title-button');
    title.textContent = article?.title || 'Untitled';
    title.dataset.action = 'read';
    fragment.querySelector('.teaser').textContent = article?.teaser || '';
    const content = fragment.querySelector('.content');
    if (article?.topics?.length) {
        const row = document.createElement('div');
        row.className = 'article-topics';
        for (const topic of article.topics) row.appendChild(createTopicChip(topic, { activeSlug: activeTopic }));
        content.appendChild(row);
    }

    const actions = [
        ['.article-save-btn', 'save'], ['.article-dismiss-btn', 'dismiss'], ['.btn-open-external', 'external'],
    ];
    for (const [selector, action] of actions) {
        const button = fragment.querySelector(selector);
        button.dataset.action = action;
        if (validId) button.dataset.articleId = String(id);
        else button.disabled = true;
    }
    const save = fragment.querySelector('.article-save-btn');
    save.classList.toggle('is-saved', Boolean(article?.saved));
    const saveIcon = document.createElement('i');
    saveIcon.className = `${article?.saved ? 'fa-solid' : 'fa-regular'} fa-bookmark`;
    saveIcon.setAttribute('aria-hidden', 'true');
    save.replaceChildren(saveIcon, document.createTextNode(article?.saved ? ' Saved' : ' Save'));
    fragment.querySelector('.btn-open-external').setAttribute('aria-label', `Open ${article?.title || 'article'} externally`);
    return fragment;
}
