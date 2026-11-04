// Settings sent with the data: the refresh interval and the host group name.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

test('the refresh interval from the settings is followed, and changes are picked up', async () => {
    const data = Object.assign(fixture('small'), {refresh: 30, hostgroup: 'web-checks'});
    const {page, server, errors, close} = await open({data, clock: true});
    const advance = async seconds => {
        await page.clock.runFor(seconds * 1000);
        await page.waitForTimeout(150);
    };
    try {
        const start = server.fetches;
        await advance(16);
        assert.equal(server.fetches - start, 0, 'no fetch after 15 s with a 30 s interval');
        await advance(15);
        assert.equal(server.fetches - start, 1, 'fetch after 30 s');

        data.refresh = 10; // setting changed on the server
        await advance(30);
        const changed = server.fetches;
        await advance(10);
        assert.equal(server.fetches - changed, 1, 'the new 10 s interval is used');
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('the host group name from the settings is shown', async () => {
    const data = Object.assign(fixture('small'), {hostgroup: 'web-checks'});
    data.nodes.find(n => n.name === 'core-router').synthetic = false;
    const {page, server, close} = await open({data});
    try {
        const title = await page.$eval('.clustergraph-viewport a[href="#core-router"] title', t => t.textContent);
        assert.match(title, /not in the web-checks host group/);

        server.data = {nodes: [], links: [], hostgroup: 'web-checks'};
        await page.evaluate(() => cg.onRenderedContainer());
        await page.waitForTimeout(500);
        assert.equal(await page.textContent('.clustergraph-empty'), 'No hosts found in the "web-checks" host group.');
    } finally {
        await close();
    }
});
