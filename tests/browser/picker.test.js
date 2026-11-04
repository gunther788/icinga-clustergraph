// The host checklist: subsets, multiple selection, filter, and the selection
// kept in the page URL (and Icinga's data-icinga-url) for bookmarks.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, drawnHosts, PAGE} = require('./harness');

const state = page => page.evaluate(() => ({
    url: location.pathname + location.search,
    icingaUrl: document.getElementById('col1').getAttribute('data-icinga-url'),
    button: document.querySelector('.clustergraph-picker-button').textContent,
    checked: [...document.querySelectorAll('.clustergraph-picker-list input:checked')].map(i => i.value)
}));

test('a bookmarked subset opens with those hosts ticked', async () => {
    const {page, errors, close} = await open({data: fixture('random40'), query: '?host=queue&host=db-c'});
    try {
        const s = await state(page);
        assert.equal(s.url, PAGE + '?host=queue&host=db-c');
        assert.equal(s.icingaUrl, PAGE + '?host=queue&host=db-c');
        assert.deepEqual(s.checked, ['db-c', 'queue']);
        assert.equal(s.button, '2 hosts ▾');
        const hosts = await drawnHosts(page);
        assert.ok(hosts.includes('queue') && hosts.includes('db-c'));
        assert.ok(!hosts.includes('cache'), 'hosts outside the subset are hidden');
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('ticking, filtering and showing all', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        const all = (await drawnHosts(page)).length;
        await page.click('.clustergraph-picker-button');
        const listed = await page.$$eval('.clustergraph-picker-list label', ls => ls.map(l => l.textContent.trim()));
        assert.deepEqual(listed, ['cache', 'db-a', 'db-b', 'db-c', 'idle-0', 'idle-1', 'idle-2', 'idle-3', 'queue'],
            'every host without children, alphabetically');

        await page.fill('.clustergraph-picker-head input', 'idle');
        const visible = await page.$$eval('.clustergraph-picker-list label:not([hidden])', ls => ls.length);
        assert.equal(visible, 4, 'the filter narrows the list');
        await page.fill('.clustergraph-picker-head input', '');

        await page.click('.clustergraph-picker-list input[value="queue"]');
        await page.waitForTimeout(400);
        const one = (await drawnHosts(page)).length;
        assert.ok(one < all);
        await page.click('.clustergraph-picker-list input[value="cache"]');
        await page.waitForTimeout(400);
        const two = await state(page);
        assert.equal(two.url, PAGE + '?host=cache&host=queue');
        assert.equal(two.icingaUrl, PAGE + '?host=cache&host=queue');
        assert.ok((await drawnHosts(page)).length > one, 'a second host adds its chain');

        await page.mouse.click(400, 400);
        assert.equal(await page.$eval('.clustergraph-picker', p => p.hidden), true, 'closes on an outside click');

        await page.click('.clustergraph-picker-button');
        await page.click('.clustergraph-picker-head button');
        await page.waitForTimeout(400);
        assert.equal((await state(page)).url, PAGE);
        assert.equal((await drawnHosts(page)).length, all);
    } finally {
        await close();
    }
});

test('unknown hosts in the URL are dropped', async () => {
    const {page, close} = await open({data: fixture('random40'), query: '?host=nope&host=db-c'});
    try {
        const s = await state(page);
        assert.equal(s.url, PAGE + '?host=db-c');
        assert.deepEqual(s.checked, ['db-c']);
    } finally {
        await close();
    }
});
