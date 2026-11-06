// Loading progress: a card while the first drawing is made, a slim bar for
// later re-layouts, and the reason in the card if loading fails.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, drawnHosts} = require('./harness');

const loadingState = page => page.evaluate(() => {
    const loading = document.querySelector('.topologygraph-loading');
    return {
        shown: !loading.hidden,
        card: loading.classList.contains('topologygraph-loading-first'),
        text: loading.querySelector('.topologygraph-loading-text').textContent,
        bar: loading.querySelector('.topologygraph-loading-fill').style.width,
        emptyMessage: !document.querySelector('.topologygraph-empty').hidden
    };
});

test('a progress card is shown while the data loads', async () => {
    const data = fixture('random40');
    const {page, errors, close} = await open({data, delay: 1500, wait: false});
    try {
        await page.waitForTimeout(500);
        const waiting = await loadingState(page);
        assert.deepEqual(
            [waiting.shown, waiting.card, waiting.text, waiting.emptyMessage],
            [true, true, 'Loading hosts from Icinga…', false],
            'card while waiting, and no "no hosts" message'
        );
        assert.ok(parseInt(waiting.bar, 10) > 0, 'the bar has started');
        await page.waitForSelector('.topologygraph-viewport svg a', {timeout: 10000});
        await page.waitForTimeout(300);
        assert.equal((await loadingState(page)).shown, false, 'gone once drawn');
        assert.equal((await drawnHosts(page)).length, data.nodes.length);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('the card explains why loading failed', async () => {
    const {page, server, close} = await open({data: fixture('small'), delay: 300, wait: false});
    try {
        server.fail = true;
        await page.waitForTimeout(1000);
        const failed = await loadingState(page);
        assert.equal(failed.shown, true);
        assert.match(failed.text, /^Could not load the graph \(HTTP 500\)\. Reload the page to try again\.$/);
    } finally {
        await close();
    }
});

test('a slim bar shows while the graph is laid out again', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        // Record every state the loading element goes through, so a quick
        // re-layout can't finish before the test looks
        await page.evaluate(() => {
            const loading = document.querySelector('.topologygraph-loading');
            window.loadingSeen = [];
            new MutationObserver(() => {
                if (!loading.hidden) {
                    window.loadingSeen.push({
                        card: loading.classList.contains('topologygraph-loading-first'),
                        text: loading.querySelector('.topologygraph-loading-text').textContent
                    });
                }
            }).observe(loading, {attributes: true, childList: true, subtree: true, characterData: true});
        });
        await page.click('.topologygraph-picker-button');
        await page.click('.topologygraph-picker-list input[value="queue"]');
        await page.waitForTimeout(800);
        const seen = await page.evaluate(() => window.loadingSeen);
        assert.ok(seen.length > 0, 'progress was shown');
        assert.ok(seen.every(s => !s.card), 'as the slim bar, not the card');
        assert.ok(seen.some(s => /^Laying out \d+ hosts\u2026$/.test(s.text)), JSON.stringify(seen));
        assert.equal(await page.$eval('.topologygraph-loading', l => l.hidden), true, 'and gone afterwards');
    } finally {
        await close();
    }
});
