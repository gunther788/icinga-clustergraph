// The graph fills the browser window edge to edge, follows resizes, stays
// compact on large screens and supports full screen.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, transform} = require('./harness');

const geometry = page => page.evaluate(() => {
    const v = document.querySelector('.clustergraph-viewport');
    const c = document.querySelector('.container');
    const r = v.getBoundingClientRect(), cr = c.getBoundingClientRect();
    return {
        gapLeft: Math.round(r.left - cr.left),
        gapRight: Math.round(cr.left + c.clientWidth - r.right),
        gapBottom: Math.round(innerHeight - r.bottom),
        pageScrolls: c.scrollHeight > c.clientHeight || c.scrollWidth > c.clientWidth,
        fullscreen: document.fullscreenElement === v
    };
});

test('fills the window below the tabs without scrolling, and follows resizes', async () => {
    const {page, errors, close} = await open({data: fixture('random40')});
    try {
        for (const size of [{width: 1280, height: 720}, {width: 1000, height: 900}, {width: 1700, height: 520}]) {
            await page.setViewportSize(size);
            await page.waitForTimeout(700);
            const g = await geometry(page);
            assert.deepEqual([g.gapLeft, g.gapRight, g.gapBottom, g.pageScrolls], [0, 0, 0, false],
                `${size.width}x${size.height}: ${JSON.stringify(g)}`);
            assert.ok((await transform(page)).k > 0.5, 'diagram is shown at a readable size');
        }
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});

test('stays compact on a large screen', async () => {
    const {page, close} = await open({data: fixture('random40'), viewport: {width: 2560, height: 1440}});
    try {
        // Gaps between the side-by-side lists of boxes stay small
        const gaps = await page.evaluate(() => {
            const rects = [...document.querySelectorAll('.clustergraph-viewport rect')].map(r => r.getBoundingClientRect());
            const columns = [];
            rects.forEach(r => {
                const column = columns.find(c => Math.abs(c.left - r.left) < 30 || Math.abs(c.right - r.right) < 30);
                if (column) {
                    column.left = Math.min(column.left, r.left);
                    column.right = Math.max(column.right, r.right);
                } else {
                    columns.push({left: r.left, right: r.right});
                }
            });
            columns.sort((a, b) => a.left - b.left);
            return columns.slice(1).map((c, i) => c.left - columns[i].right);
        });
        assert.ok(gaps.length > 0);
        assert.ok(Math.max(...gaps) < 40, `gaps between box lists: ${gaps}`);
        assert.equal((await transform(page)).k, 1, 'shown at 100%');
    } finally {
        await close();
    }
});

test('full screen covers the window and comes back', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        await page.click('button[title^="Toggle full screen"]');
        await page.waitForTimeout(600);
        const inside = await page.evaluate(() => {
            const r = document.querySelector('.clustergraph-viewport').getBoundingClientRect();
            return {fullscreen: document.fullscreenElement !== null, width: r.width, height: r.height};
        });
        assert.deepEqual(inside, {fullscreen: true, width: 1280, height: 720});
        assert.equal(await page.textContent('button[title^="Toggle full screen"]'), 'Exit full screen');
        await page.click('button[title^="Toggle full screen"]');
        await page.waitForTimeout(600);
        assert.equal((await geometry(page)).fullscreen, false);
    } finally {
        await close();
    }
});
