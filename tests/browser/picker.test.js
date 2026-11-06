// The host checklist: subsets, multiple selection, filter, and the selection
// kept in the page URL (and Icinga's data-icinga-url) for bookmarks.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, drawnHosts, PAGE} = require('./harness');

const state = page => page.evaluate(() => ({
    url: location.pathname + location.search,
    icingaUrl: document.getElementById('col1').getAttribute('data-icinga-url'),
    button: document.querySelector('.topologygraph-picker-button').textContent,
    checked: [...document.querySelectorAll('.topologygraph-picker-list input:checked')].map(i => i.value)
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
        await page.click('.topologygraph-picker-button');
        const listed = await page.$$eval('.topologygraph-picker-list label', ls => ls.map(l => l.textContent.trim()));
        assert.deepEqual(listed, ['cache', 'db-a', 'db-b', 'db-c', 'idle-0', 'idle-1', 'idle-2', 'idle-3', 'queue'],
            'every host without children, alphabetically');

        await page.fill('.topologygraph-picker-head input', 'idle');
        const visible = await page.$$eval('.topologygraph-picker-list label:not([hidden])', ls => ls.length);
        assert.equal(visible, 4, 'the filter narrows the list');
        await page.fill('.topologygraph-picker-head input', '');

        await page.click('.topologygraph-picker-list input[value="queue"]');
        await page.waitForTimeout(400);
        const one = (await drawnHosts(page)).length;
        assert.ok(one < all);
        await page.click('.topologygraph-picker-list input[value="cache"]');
        await page.waitForTimeout(400);
        const two = await state(page);
        assert.equal(two.url, PAGE + '?host=cache&host=queue');
        assert.equal(two.icingaUrl, PAGE + '?host=cache&host=queue');
        assert.ok((await drawnHosts(page)).length > one, 'a second host adds its chain');

        await page.mouse.click(400, 400);
        assert.equal(await page.$eval('.topologygraph-picker', p => p.hidden), true, 'closes on an outside click');

        await page.click('.topologygraph-picker-button');
        await page.click('.topologygraph-picker-head button');
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

// random40 with host groups: three databases, the messaging hosts, and the probes
function withGroups() {
    const data = fixture('random40');
    data.nodes.forEach(n => {
        n.groups = [];
        if (/^db-/.test(n.name)) n.groups.push('databases');
        if (n.name === 'queue' || n.name === 'cache') n.groups.push('messaging');
        if (/^probe-/.test(n.name)) n.groups.push('synthetic');
    });
    return data;
}

test('a host group in the URL works like ticking its hosts', async () => {
    const data = withGroups();
    const byGroup = await open({data, query: '?hostgroup=databases'});
    const byHosts = await open({data, query: '?host=db-a&host=db-b&host=db-c'});
    try {
        const viaGroup = await drawnHosts(byGroup.page);
        assert.ok(viaGroup.length > 3 && viaGroup.length < data.nodes.length, 'a subset including the chains above');
        assert.deepEqual(viaGroup, await drawnHosts(byHosts.page), 'same hosts as ticking db-a, db-b and db-c');
        const s = await state(byGroup.page);
        assert.equal(s.url, PAGE + '?hostgroup=databases');
        assert.equal(s.icingaUrl, PAGE + '?hostgroup=databases');
        assert.equal(s.button, 'databases ▾');
        assert.deepEqual(await byGroup.page.$$eval('.topologygraph-picker-groups input:checked', i => i.map(x => x.value)), ['databases']);
        assert.deepEqual(byGroup.errors, []);
    } finally {
        await byGroup.close();
        await byHosts.close();
    }
});

test('ticking host groups, combined with hosts', async () => {
    const {page, close} = await open({data: withGroups()});
    try {
        await page.click('.topologygraph-picker-button');
        const groups = await page.$$eval('.topologygraph-picker-groups label', ls => ls.map(l => l.textContent.trim()));
        assert.deepEqual(groups, ['databases', 'messaging', 'synthetic'], 'every group of a drawn host');

        await page.click('.topologygraph-picker-groups input[value="messaging"]');
        await page.waitForTimeout(400);
        assert.equal((await state(page)).url, PAGE + '?hostgroup=messaging');
        const messaging = await drawnHosts(page);
        assert.ok(messaging.includes('queue') && messaging.includes('cache') && !messaging.includes('db-a'));

        await page.click('.topologygraph-picker-list:not(.topologygraph-picker-groups) input[value="db-a"]');
        await page.waitForTimeout(400);
        const both = await state(page);
        assert.equal(both.url, PAGE + '?host=db-a&hostgroup=messaging', 'hosts and groups together');
        assert.equal(both.button, 'messaging, db-a ▾');
        assert.ok((await drawnHosts(page)).includes('db-a'));

        await page.fill('.topologygraph-picker-head input', 'data');
        const visible = await page.$$eval('.topologygraph-picker-lists label:not([hidden])', ls => ls.map(l => l.textContent.trim()));
        assert.deepEqual(visible, ['databases'], 'the filter covers groups too');
        await page.fill('.topologygraph-picker-head input', '');

        await page.click('.topologygraph-picker-head button');
        await page.waitForTimeout(400);
        assert.equal((await state(page)).url, PAGE, 'Show all clears hosts and groups');
    } finally {
        await close();
    }
});

test('unknown host groups in the URL are dropped', async () => {
    const {page, close} = await open({data: withGroups(), query: '?hostgroup=nope&hostgroup=databases'});
    try {
        assert.equal((await state(page)).url, PAGE + '?hostgroup=databases');
    } finally {
        await close();
    }
});
