// The ELK layout engine (?layout=elk): loaded on demand, arrows routed around
// hosts and boxes, switchable from the controls, and a fallback when it can't
// be loaded. Plus the animation when the graph is laid out again.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, routeMetrics, drawnHosts, transform, PAGE} = require('./harness');

const waitForElk = page => page.waitForFunction(() => {
    const paths = document.querySelectorAll('.topologygraph-viewport svg path[marker-end]');
    return paths.length && [...paths].every(p => !p.getAttribute('d').includes('C'));
}, null, {timeout: 20000});

test('the ELK layout routes arrows around hosts and boxes', async () => {
    const data = fixture('parents23');
    const {page, server, errors, close} = await open({data, query: '?layout=elk'});
    try {
        await waitForElk(page);
        assert.equal(server.elkRequests, 1, 'ELK is fetched once, on demand');
        assert.equal((await drawnHosts(page)).length, data.nodes.length, 'every host is drawn');
        const m = await routeMetrics(page);
        assert.ok(m.arrows > 0);
        assert.equal(m.throughBoxesOrLabels, 0, 'no arrow runs through a box or label');
        assert.equal(await page.$eval('.topologygraph-layout', s => s.value), 'elk');
        assert.ok(await page.$$eval('.topologygraph-viewport svg rect', r => r.length) > 0, 'groups are still boxed');
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('ELK is not loaded for the standard layout', async () => {
    const {server, close} = await open({data: fixture('small')});
    try {
        assert.equal(server.elkRequests, 0);
    } finally {
        await close();
    }
});

test('switching layout engines from the controls updates the URL', async () => {
    const {page, close} = await open({data: fixture('small'), query: '?host=db-1'});
    try {
        await page.selectOption('.topologygraph-layout', 'elk');
        await waitForElk(page);
        assert.equal(await page.evaluate(() => location.pathname + location.search), PAGE + '?host=db-1&layout=elk');
        await page.selectOption('.topologygraph-layout', 'standard');
        await page.waitForTimeout(700);
        assert.equal(await page.evaluate(() => location.pathname + location.search), PAGE + '?host=db-1');
        const curved = await page.$$eval('.topologygraph-viewport svg path[marker-end]', ps => ps.every(p => p.getAttribute('d').includes('C')));
        assert.ok(curved, 'back to the standard curves');
    } finally {
        await close();
    }
});

test('if ELK cannot be loaded, the standard layout is used and the reason shown', async () => {
    const data = fixture('small');
    const {page, errors, close} = await open({data, query: '?layout=elk', elkFail: true});
    try {
        await page.waitForSelector('.topologygraph-viewport svg a');
        assert.equal((await drawnHosts(page)).length, data.nodes.length);
        assert.match(await page.textContent('.topologygraph-note'), /ELK layout failed \(could not load ELK\), using the standard layout/);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('live state changes recolour an ELK drawing in place', async () => {
    const data = fixture('small');
    const {page, close} = await open({data, query: '?layout=elk', clock: true});
    try {
        await page.clock.runFor(1000);
        await waitForElk(page);
        const before = await page.$eval('.topologygraph-viewport a[href="#api-1"]', a => a.getAttribute('transform'));
        data.nodes.find(n => n.name === 'api-1').state = 1;
        await page.clock.runFor(15000);
        await page.waitForTimeout(300);
        const after = await page.$eval('.topologygraph-viewport a[href="#api-1"]', a => ({
            transform: a.getAttribute('transform'),
            fill: a.querySelector('circle:last-of-type').getAttribute('fill')
        }));
        assert.equal(after.fill, '#ff5566', 'recoloured');
        assert.equal(after.transform, before, 'not laid out again');
    } finally {
        await close();
    }
});

test('hosts glide to their new places when the graph is laid out again', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        // Position in the drawing's own coordinates (the host's translate plus
        // the drawing's vertical offset), independent of the zoom
        const position = () => page.evaluate(() => {
            const a = document.querySelector('.topologygraph-viewport a[href="#queue"]');
            const content = document.querySelector('.topologygraph-viewport svg > g > g');
            const xy = t => (/translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(t) || [0, 0, 0]).slice(1).map(Number);
            const [x, y] = xy(a.getAttribute('transform'));
            const [, offset] = xy(content.getAttribute('transform'));
            return {x, y: y + offset};
        });
        const close_ = (a, b, d) => Math.abs(a.x - b.x) <= d && Math.abs(a.y - b.y) <= d;
        const start = await position();
        // Showing a subset lays the graph out again
        await page.click('.topologygraph-picker-button');
        await page.click('.topologygraph-picker-list input[value="queue"]');
        const early = await position();
        await page.waitForTimeout(700);
        const settled = await position();
        await page.waitForTimeout(150);
        assert.ok(close_(early, start, 4), `starts where it was: ${JSON.stringify(early)} vs ${JSON.stringify(start)}`);
        assert.ok(!close_(settled, start, 5), 'ends somewhere new');
        assert.ok(close_(await position(), settled, 0.5), 'and stays there');
    } finally {
        await close();
    }
});

test('the hybrid layout wraps the tall column of boxes and keeps ELK routing', async () => {
    const data = fixture('random40');
    const {page, errors, close} = await open({data, query: '?layout=hybrid', viewport: {width: 1400, height: 800}});
    try {
        await waitForElk(page);
        assert.equal(await page.$eval('.topologygraph-layout', s => s.value), 'hybrid');
        assert.equal((await drawnHosts(page)).length, data.nodes.length);
        const m = await routeMetrics(page);
        assert.equal(m.shownAt, '100%', 'fits at full size (plain ELK needs 64% here)');
        assert.equal(m.throughBoxesOrLabels, 0, 'no arrow runs through a box or label');
        // The boxes of hosts with children sit in more than one column
        const columns = await page.$$eval('.topologygraph-viewport svg rect', rects => {
            const rights = rects.filter(r => +r.getAttribute('height') > 60).map(r => Math.round(+r.getAttribute('x') + +r.getAttribute('width')));
            return new Set(rights).size;
        });
        assert.ok(columns >= 2, `boxes in ${columns} columns`);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});
