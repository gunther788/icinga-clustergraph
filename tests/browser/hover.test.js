// Hovering a host highlights its chain above and below and dims the rest.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture} = require('./harness');

const dimmed = page => page.evaluate(() => {
    const hosts = {};
    document.querySelectorAll('.topologygraph-viewport svg a').forEach(a => {
        hosts[a.querySelector('text').textContent] = a.style.opacity === '' ? 'shown' : 'dimmed';
    });
    const arrows = [...document.querySelectorAll('.topologygraph-viewport svg path[marker-end]')]
        .map(p => p.style.opacity === '' || p.style.opacity === '1' ? 'shown' : 'dimmed');
    return {hosts, shownArrows: arrows.filter(a => a === 'shown').length, arrows: arrows.length};
});

test('hovering a host highlights everything above and below it', async () => {
    const {page, errors, close} = await open({data: fixture('small')});
    try {
        await page.hover('.topologygraph-viewport a[href="#web-1"] circle:last-of-type');
        await page.waitForTimeout(100);
        const on = await dimmed(page);
        const shown = Object.keys(on.hosts).filter(h => on.hosts[h] === 'shown').sort();
        // web-1: parents lb-1 <- fw-1, fw-2 <- core-router; child db-1
        assert.deepEqual(shown, ['core-router', 'db-1', 'fw-1', 'fw-2', 'lb-1', 'web-1']);
        // Arrows on the chain: core-router->fw-1, core-router->fw-2, fw-1->lb-1, fw-2->lb-1, lb-1->web-1, web-1->db-1
        assert.equal(on.shownArrows, 6);

        await page.mouse.move(5, 5);
        await page.waitForTimeout(100);
        const off = await dimmed(page);
        assert.ok(Object.values(off.hosts).every(v => v === 'shown'), 'everything back after leaving');
        assert.equal(off.shownArrows, off.arrows);
        assert.deepEqual(errors, []);
    } finally {
        await close();
    }
});
