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

// A server offering three host groups (synthetic the default) that marks
// the hosts of the graphed groups as members, as the real one does
function groupServer(data = withGroups()) {
    const offered = ['synthetic', 'databases', 'messaging'];
    return params => {
        const asked = params.getAll('hostgroup');
        const chosen = asked.filter(g => offered.includes(g));
        const graphed = chosen.length ? chosen : ['synthetic'];
        return Object.assign({}, data, {
            nodes: data.nodes.map(n => Object.assign({}, n, {member: n.groups.some(g => graphed.includes(g))})),
            hostgroups: graphed,
            hostgroups_ignored: asked.filter(g => !offered.includes(g)),
            hostgroups_offered: offered.map(name => ({name, label: name === 'databases' ? 'Databases' : name})),
            hostgroup_default: 'synthetic'
        });
    };
}

const groupState = page => page.evaluate(() => ({
    button: document.querySelector('.topologygraph-hostgroup-button').textContent,
    hidden: document.querySelector('.topologygraph-hostgroup-button').hidden,
    checked: [...document.querySelectorAll('.topologygraph-hostgroup-list input:checked')].map(i => i.value),
    url: location.pathname + location.search,
    note: document.querySelector('.topologygraph-hint').textContent
}));

test('the host group picker graphs the chosen groups', async () => {
    const {page, server, errors, close} = await open({data: groupServer()});
    try {
        let s = await groupState(page);
        assert.equal(s.button, 'synthetic ▾', 'the default to start with');
        assert.deepEqual(s.checked, ['synthetic']);
        assert.equal(server.queries[0], '', 'the default needs no parameter');

        await page.click('.topologygraph-hostgroup-button');
        const listed = await page.$$eval('.topologygraph-hostgroup-list label', ls => ls.map(l => l.textContent.trim()));
        assert.deepEqual(listed, ['synthetic', 'Databases (databases)', 'messaging'], 'the offered groups');
        // Two ticks in quick succession load once
        const before = server.fetches;
        await page.click('.topologygraph-hostgroup-list input[value="databases"]');
        await page.click('.topologygraph-hostgroup-list input[value="messaging"]');
        await page.waitForTimeout(1000);
        assert.equal(server.fetches, before + 1, 'one load for both ticks');
        assert.equal(server.queries[server.queries.length - 1], '?hostgroup=synthetic&hostgroup=databases&hostgroup=messaging');
        s = await groupState(page);
        assert.equal(s.url, PAGE + '?hostgroup=synthetic&hostgroup=databases&hostgroup=messaging');
        assert.equal(s.button, '3 host groups ▾');
        const weight = name => page.$eval(`.topologygraph-viewport a[href="#${name}"] text`, t => t.getAttribute('font-weight'));
        assert.equal(await weight('db-a'), 'bold', 'hosts of a chosen group are members');

        await page.click('.topologygraph-hostgroup-picker .topologygraph-picker-head button');
        await page.waitForTimeout(1000);
        assert.equal(server.queries[server.queries.length - 1], '', 'Default: back to no parameter');
        s = await groupState(page);
        assert.equal(s.url, PAGE);
        assert.deepEqual(s.checked, ['synthetic']);
        assert.equal(await weight('db-a'), 'normal');
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('a bookmarked host group is graphed, and the host checklist narrows within it', async () => {
    const {page, server, close} = await open({data: groupServer(), query: '?hostgroup=databases&host=queue'});
    try {
        assert.equal(server.queries[0], '?hostgroup=databases');
        const s = await groupState(page);
        assert.equal(s.button, 'Databases ▾');
        assert.equal(s.url, PAGE + '?host=queue&hostgroup=databases');
        assert.equal((await state(page)).button, 'queue ▾');
        assert.ok((await drawnHosts(page)).includes('queue'));
    } finally {
        await close();
    }
});

test('host groups not offered are dropped from the address and noted', async () => {
    const {page, close} = await open({data: groupServer(), query: '?hostgroup=nope&hostgroup=databases'});
    try {
        const s = await groupState(page);
        assert.equal(s.url, PAGE + '?hostgroup=databases');
        assert.match(s.note, /Not offered in the module settings: nope/);
    } finally {
        await close();
    }
});

test('no group picker when only the default is offered', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        assert.equal((await groupState(page)).hidden, true);
        assert.equal(await page.$eval('.topologygraph-picker-button', b => b.hidden), false, 'the host checklist stays');
    } finally {
        await close();
    }
});

test('the explain link follows the selection and keeps what the graph lacks', async () => {
    const {page, close} = await open({data: groupServer(), query: '?hostgroup=nope&hostgroup=databases&host=ghost'});
    const href = () => page.$eval('.topologygraph-picker-explain', a => a.getAttribute('href'));
    try {
        assert.equal(await href(), PAGE + '/index/explain?host=ghost&hostgroup=databases&hostgroup=nope',
            'dropped from the view, but still explained');
        await page.click('.topologygraph-picker-button');
        await page.click('.topologygraph-picker-list input[value="queue"]');
        await page.waitForTimeout(200);
        assert.equal(await href(), PAGE + '/index/explain?host=queue&host=ghost&hostgroup=databases&hostgroup=nope');
        assert.equal(await page.$eval('.topologygraph-picker-explain', a => a.target), '_blank');
    } finally {
        await close();
    }
});
