// Zooming and moving: wheel, Shift + wheel, buttons, and links vs dragging.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {open, fixture, transform} = require('./harness');

test('the wheel zooms around the pointer and Shift + wheel moves', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        const pointer = {x: 700, y: 400};
        const under = async () => {
            const t = await transform(page);
            const box = await page.$eval('.clustergraph-viewport', v => v.getBoundingClientRect().toJSON());
            return {x: (pointer.x - box.left - t.x) / t.k, y: (pointer.y - box.top - t.y) / t.k};
        };
        await page.mouse.move(pointer.x, pointer.y);
        const start = await transform(page);
        const before = await under();

        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(150);
        const zoomed = await transform(page);
        assert.ok(Math.abs(zoomed.k / start.k - 1.15) < 0.02, `one notch zooms ~15% (got ${zoomed.k / start.k})`);
        const after = await under();
        assert.ok(Math.abs(after.x - before.x) < 3 && Math.abs(after.y - before.y) < 3, 'point under the pointer stays put');

        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(150);
        assert.ok(Math.abs((await transform(page)).k - start.k) < 0.01, 'scrolling back returns to the start');

        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(150);
        const t0 = await transform(page);
        await page.keyboard.down('Shift');
        await page.mouse.wheel(0, 120);
        await page.keyboard.up('Shift');
        await page.waitForTimeout(100);
        const t1 = await transform(page);
        assert.equal(t1.k, t0.k, 'Shift + wheel does not zoom');
        assert.ok(Math.abs(t1.y - t0.y) > 50, 'Shift + wheel moves the diagram');

        assert.equal(await page.evaluate(() => document.querySelector('.container').scrollTop + scrollY), 0,
            'the page never scrolls');
    } finally {
        await close();
    }
});

test('zoom buttons', async () => {
    const {page, close} = await open({data: fixture('random40')});
    try {
        const fitted = (await transform(page)).k;
        await page.click('button[title="Zoom in"]');
        await page.waitForTimeout(400);
        assert.ok(Math.abs((await transform(page)).k / fitted - 1.4) < 0.01, '+ zooms in 1.4x');
        await page.click('button[title="Zoom out"]');
        await page.waitForTimeout(400);
        assert.ok(Math.abs((await transform(page)).k - fitted) < 0.01, '- zooms back out');
        await page.click('button[title="Show at 100%"]');
        await page.waitForTimeout(400);
        assert.ok(Math.abs((await transform(page)).k - 1) < 0.01, '1:1 shows 100%');
        await page.click('button[title="Fit the whole diagram"]');
        await page.waitForTimeout(400);
        assert.ok(Math.abs((await transform(page)).k - fitted) < 0.01, 'Fit returns to the fitted view');
    } finally {
        await close();
    }
});

test('a click opens a host, a drag does not', async () => {
    const {page, close} = await open({data: fixture('small')});
    try {
        const dot = page.locator('.clustergraph-viewport a[href="#lb-1"] circle').last();
        const box = await dot.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + 80, box.y + 20, {steps: 5});
        await page.mouse.up();
        assert.equal(await page.evaluate(() => location.hash), '', 'drag does not follow the link');
        const moved = await dot.boundingBox();
        await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
        assert.equal(await page.evaluate(() => location.hash), '#lb-1', 'click follows the link');
    } finally {
        await close();
    }
});
