// Live updates: state changes recolour in place, structure changes re-lay
// out, failures are reported, and only one refresh loop ever runs.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, transform} = require('./harness');

const REFRESH_MS = 15000;

const snapshot = page => page.evaluate(() => {
    const v = document.querySelector('.topologygraph-viewport');
    if (!v.dataset.id) v.dataset.id = String(Math.random());
    return {
        viewport: v.dataset.id,
        hosts: v.querySelectorAll('svg a').length,
        red: [...v.querySelectorAll('svg a')]
            .filter(a => a.querySelector('circle:last-of-type').getAttribute('fill') === '#ff5566')
            .map(a => a.querySelector('text').textContent).sort(),
        status: v.querySelector('.topologygraph-hint span').textContent
    };
});

test('live updates', async () => {
    const data = fixture('small');
    const {page, server, errors, close} = await open({data, clock: true});
    const tick = async () => {
        await page.clock.runFor(REFRESH_MS);
        await page.waitForTimeout(200);
    };
    try {
        const first = await snapshot(page);
        assert.deepEqual(first.red, ['web-2']);
        assert.match(first.status, /^Updated /);

        // Zoom in, then a state change: same drawing, recoloured, zoom kept
        await page.click('button[title="Zoom in"]');
        await page.clock.runFor(500);
        await page.waitForTimeout(100);
        const zoomed = await transform(page);
        data.nodes.find(n => n.name === 'web-2').state = 0;
        data.nodes.find(n => n.name === 'api-1').state = 1;
        await tick();
        const recoloured = await snapshot(page);
        assert.equal(recoloured.viewport, first.viewport, 'same viewport');
        assert.deepEqual(recoloured.red, ['api-1']);
        assert.deepEqual(await transform(page), zoomed, 'zoom kept');

        // A new host: re-laid out, zoom kept
        data.nodes.push({name: 'web-3', label: 'web-3', state: 0, last_check: 1, synthetic: true, link: '#web-3'});
        data.links.push({source: 'lb-1', target: 'web-3'});
        await tick();
        const grown = await snapshot(page);
        assert.equal(grown.hosts, first.hosts + 1);
        assert.equal(grown.viewport, first.viewport, 'the viewport is reused');
        assert.equal((await transform(page)).k, zoomed.k, 'zoom kept');

        // A failed fetch is reported, and the next one recovers
        server.fail = true;
        await tick();
        assert.match((await snapshot(page)).status, /^Update failed/);
        server.fail = false;
        await tick();
        assert.match((await snapshot(page)).status, /^Updated /);

        // Rendering again must not start a second refresh loop
        await page.evaluate(() => cg.onRenderedContainer());
        await page.clock.runFor(500);
        await page.waitForTimeout(200);
        const before = server.fetches;
        await tick();
        await tick();
        assert.equal(server.fetches - before, 2, 'one fetch per interval');

        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});
