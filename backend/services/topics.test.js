import test from 'node:test';
import assert from 'node:assert/strict';

// These classifier unit tests must never open a user's library or depend on
// their editable project keyword definitions.
process.env.DB_PATH = ':memory:';
const {
    classifyArticleTopicsFromDefinitions,
    definitionsToRulesObject,
    validateAndNormalizeTopicDefinitions,
} = await import('./topics.js');
const { closeDatabase } = await import('../database/datenbank.js');
test.after(closeDatabase);

const AMBIGUITY_FIXTURES = validateAndNormalizeTopicDefinitions({
    meta: {
        label: 'Meta', strong: ['meta', 'facebook'], medium: [], weak: [], exclude: ['meta analyse'],
    },
    microsoft: {
        label: 'Microsoft', strong: ['microsoft teams', 'microsoft'], medium: ['azure'], weak: [],
    },
    crypto: {
        label: 'Crypto', strong: ['bitcoin', 'blockchain'], medium: ['cryptocurrency'], weak: [],
    },
    gaming: {
        label: 'Gaming', strong: ['playstation', 'nintendo'], medium: ['steam'], weak: [],
    },
});

function getAmbiguityFixture(slug) {
    const topic = AMBIGUITY_FIXTURES.find(definition => definition.slug === slug);
    assert.ok(topic, `Expected synthetic topic fixture ${slug}`);
    return topic;
}

const TOPIC_DEFINITIONS = [
    {
        slug: 'ki',
        label: 'KI',
        strong: ['künstliche intelligenz', 'artificial intelligence', 'chatgpt', 'openai', 'claude', 'llm', 'generative ai'],
        medium: ['copilot', 'prompting', 'gemini', 'anthropic', 'embedding'],
        weak: ['modell', 'inferenz', 'fine tuning'],
    },
    {
        slug: 'startup',
        label: 'Startup',
        strong: ['startup', 'venture capital', 'seed-runde', 'series a', 'cap table'],
        medium: ['founder', 'gründung', 'runway', 'pitch deck', 'business angel'],
        weak: ['investment', 'finanzierung'],
    },
];

test('assigns ki from title: ChatGPT verändert den Support-Alltag', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        {
            title: 'ChatGPT verändert den Support-Alltag',
            teaser: 'Neue Workflows für Teams',
            content: '',
        },
        TOPIC_DEFINITIONS,
    );

    const slugs = result.assignedTopics.map(topic => topic.slug);
    assert.deepEqual(slugs, ['ki']);
    assert.ok(result.assignedTopics[0].score >= 6);
});

test('assigns startup from title: Startup sammelt Seed-Runde', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        {
            title: 'Startup sammelt Seed-Runde über 5 Mio. Euro ein',
            teaser: 'VC Markt bleibt aktiv',
            content: '',
        },
        TOPIC_DEFINITIONS,
    );

    const slugs = result.assignedTopics.map(topic => topic.slug);
    assert.deepEqual(slugs, ['startup']);
    assert.ok(result.assignedTopics[0].score >= 6);
});

test('assigns ki from body only with OpenAI + LLM + Prompting', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        {
            title: 'Tech update',
            teaser: 'Modelle im Fokus',
            content: 'OpenAI verbessert sein LLM deutlich. Prompting Patterns und Embedding Strategien werden erklärt.',
        },
        TOPIC_DEFINITIONS,
    );

    const slugs = result.assignedTopics.map(topic => topic.slug);
    assert.deepEqual(slugs, ['ki']);
    assert.ok(result.assignedTopics[0].score >= 6);
});

test('assigns no topic when there are no keyword matches', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        {
            title: 'Wetter bleibt stabil am Wochenende',
            teaser: 'Regionale Updates ohne Wirtschaftsbezug',
            content: 'Leichte Wolken, wenig Wind, keine besonderen Ereignisse.',
        },
        TOPIC_DEFINITIONS,
    );

    assert.equal(result.assignedTopics.length, 0);
    assert.equal(result.lowConfidenceTopics.length, 0);
});

test('scores the same keyword only once at its highest-scoring location', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        {
            title: 'OpenAI launches an update',
            teaser: 'OpenAI explains the update',
            content: 'OpenAI published the technical details.',
        },
        TOPIC_DEFINITIONS,
    );
    const topic = result.assignedTopics.find(entry => entry.slug === 'ki');
    const match = topic.matchedTerms.find(entry => entry.term === 'openai');

    assert.equal(topic.score, 10);
    assert.equal(topic.distinctMatches, 1);
    assert.equal(match.contribution, 10);
    assert.deepEqual(
        match.locations.map(location => location.field),
        ['title', 'teaser', 'body'],
    );
});

test('different keywords still accumulate normally', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        { title: 'OpenAI brings ChatGPT to support', teaser: '', content: '' },
        TOPIC_DEFINITIONS,
    );
    const topic = result.assignedTopics.find(entry => entry.slug === 'ki');

    assert.equal(topic.score, 20);
    assert.equal(topic.distinctMatches, 2);
});

test('minMatches prevents assignment but preserves a high-score low-confidence result', async () => {
    const definitions = [{ slug: 'strict', label: 'Strict', minMatches: 2, strong: ['openai'], medium: [], weak: [] }];
    const result = await classifyArticleTopicsFromDefinitions({ title: 'OpenAI update' }, definitions);

    assert.equal(result.assignedTopics.length, 0);
    assert.equal(result.lowConfidenceTopics[0].slug, 'strict');
    assert.equal(result.lowConfidenceTopics[0].distinctMatches, 1);
});

test('two distinct terms satisfy minMatches 2', async () => {
    const definitions = [
        { slug: 'strict', label: 'Strict', minMatches: 2, strong: ['openai', 'chatgpt'], medium: [], weak: [] },
    ];
    const result = await classifyArticleTopicsFromDefinitions({ title: 'OpenAI updates ChatGPT' }, definitions);

    assert.equal(result.assignedTopics[0].slug, 'strict');
    assert.equal(result.assignedTopics[0].distinctMatches, 2);
});

test('exclude phrases suppress a topic and remain explainable', async () => {
    const definitions = [
        {
            slug: 'meta',
            label: 'Meta',
            strong: ['meta'],
            medium: [],
            weak: [],
            exclude: ['meta analyse'],
        },
    ];
    const result = await classifyArticleTopicsFromDefinitions({ title: 'Meta-Analyse zeigt neue Effekte' }, definitions);
    const scored = result.scoredTopics[0];

    assert.equal(result.assignedTopics.length, 0);
    assert.equal(result.lowConfidenceTopics.length, 0);
    assert.equal(scored.excluded, true);
    assert.equal(scored.excludedTerms[0].term, 'meta analyse');
});

test('synthetic Meta exclusion fixture rejects Meta-Analyse', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        { title: 'Neue Meta-Analyse zur Gesundheitsforschung' },
        [getAmbiguityFixture('meta')],
    );

    assert.equal(result.assignedTopics.length, 0);
    assert.equal(result.scoredTopics[0].excluded, true);
});

test('synthetic Microsoft phrase fixture matches Microsoft Teams without generic teams', async () => {
    const microsoft = getAmbiguityFixture('microsoft');
    const explicit = await classifyArticleTopicsFromDefinitions({ title: 'Microsoft Teams gets an update' }, [microsoft]);
    const generic = await classifyArticleTopicsFromDefinitions({ title: 'Distributed teams improve collaboration' }, [microsoft]);

    assert.equal(explicit.assignedTopics[0].slug, 'microsoft');
    assert.equal(generic.assignedTopics.length, 0);
});

test('synthetic Crypto fixture rejects AI token usage', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        { title: 'LLM token limits improve for AI models', teaser: 'Token context windows grow' },
        [getAmbiguityFixture('crypto')],
    );

    assert.equal(result.assignedTopics.length, 0);
});

test('synthetic Crypto fixture assigns Bitcoin and blockchain', async () => {
    const result = await classifyArticleTopicsFromDefinitions(
        { title: 'Bitcoin adoption grows', teaser: 'Blockchain infrastructure expands' },
        [getAmbiguityFixture('crypto')],
    );

    assert.equal(result.assignedTopics[0].slug, 'crypto');
    assert.equal(result.assignedTopics[0].distinctMatches, 2);
});

test('synthetic Gaming platform fixture excludes metaphorical game', async () => {
    const gaming = getAmbiguityFixture('gaming');
    const metaphor = await classifyArticleTopicsFromDefinitions({ title: 'The hiring game has changed' }, [gaming]);
    const platforms = await classifyArticleTopicsFromDefinitions(
        { title: 'Steam, PlayStation and Nintendo announce releases' },
        [gaming],
    );

    assert.equal(metaphor.assignedTopics.length, 0);
    assert.equal(platforms.assignedTopics[0].slug, 'gaming');
    assert.equal(platforms.assignedTopics[0].distinctMatches, 3);
});

test('punctuation variants use the existing normalization', async () => {
    const definitions = [{ slug: 'ai', label: 'AI', strong: ['fine tuning'], medium: [], weak: [] }];
    const result = await classifyArticleTopicsFromDefinitions({ title: 'Fine-tuning models safely' }, definitions);

    assert.equal(result.assignedTopics[0].slug, 'ai');
});

test('type and optional fields survive JSON validation and serialization', () => {
    const normalized = validateAndNormalizeTopicDefinitions({
        example: {
            label: 'Example',
            type: ' Technology ',
            minMatches: 2,
            exclude: ['not this'],
            strong: ['signal'],
            medium: [],
            weak: [],
        },
    });
    const loaded = validateAndNormalizeTopicDefinitions(JSON.parse(JSON.stringify(definitionsToRulesObject(normalized))));

    assert.equal(loaded[0].type, 'technology');
    assert.equal(loaded[0].minMatches, 2);
    assert.deepEqual(loaded[0].exclude, ['not this']);
});

test('legacy definitions receive backwards-compatible defaults', () => {
    const [topic] = validateAndNormalizeTopicDefinitions({
        ki: { label: 'KI', strong: ['openai'], medium: ['anthropic'], weak: ['modell'] },
    });

    assert.equal(topic.type, null);
    assert.equal(topic.minMatches, 1);
    assert.deepEqual(topic.exclude, []);
});


test('explicit generic keyword fixtures retain their configured broad matching behavior', async () => {
    for (const [slug, keyword, title] of [
        ['meta', 'meta', 'Neue Meta-Analyse zur Gesundheitsforschung'],
        ['microsoft', 'teams', 'Distributed teams improve collaboration'],
        ['gaming', 'game', 'The hiring game has changed'],
    ]) {
        const result = await classifyArticleTopicsFromDefinitions({ title }, [
            { slug, label: slug, strong: [], medium: [keyword], weak: [] },
        ]);
        assert.deepEqual(result.assignedTopics.map(topic => topic.slug), [slug]);
    }
});
