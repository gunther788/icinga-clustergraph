/**
 * Shared helpers for the browser tests.
 *
 * Each test opens an Icinga-like page (header, sidebar, a scrolling column with
 * tab controls and padded content) served from http://icinga.test, with the
 * real module.js, the compiled module.less, the bundled D3 and a fake
 * /index/data endpoint whose response the test controls.
 */

const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright');
const less = require('less');

const ROOT = path.resolve(__dirname, '..', '..');
const ORIGIN = 'http://icinga.test';
const PAGE = '/icingaweb2/topologygraph';

let cssPromise = null;
function moduleCss() {
    if (!cssPromise) {
        const source = fs.readFileSync(path.join(ROOT, 'public/css/module.less'), 'utf8');
        cssPromise = less.render(source).then(output => output.css);
    }
    return cssPromise;
}

// Enough of Icinga Web's layout to exercise sizing: a fixed header and
// sidebar, and a scrolling column (#col1) with controls above padded content
const ICINGA_CSS = `
    body { margin: 0; background: #282e39; color: #ccc; font-family: sans-serif; }
    #header { height: 48px; background: #1d222b; }
    #sidebar { position: absolute; top: 48px; left: 0; bottom: 0; width: 200px; background: #1d222b; }
    .container { position: absolute; top: 48px; left: 200px; right: 0; bottom: 0; overflow: auto; }
    .controls { height: 40px; border-bottom: 1px solid #444; }
    .content { padding: 1em; }
`;

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name + '.json'), 'utf8'));
}

/**
 * Open the graph page.
 *
 * @param {object} options
 * @param {object} options.data      Graph data served by /index/data (can be changed later via server.data)
 * @param {string} [options.query]   Query string for the page URL, e.g. "?host=a"
 * @param {object} [options.viewport] Browser window size
 * @param {boolean} [options.clock]  Install Playwright's fake clock before loading
 * @returns {Promise<{browser, page, server, errors, close}>}
 */
async function open({data, query = '', viewport = {width: 1280, height: 720}, clock = false}) {
    const css = await moduleCss();
    const browser = await chromium.launch();
    const page = await browser.newPage({viewport});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const server = {data, fail: false, fetches: 0};
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${ICINGA_CSS}${css}</style></head><body>
        <div id="header"></div><div id="sidebar"></div>
        <div class="container" id="col1" data-icinga-url="${PAGE}">
          <div class="controls"></div>
          <div class="content"><div id="topologygraph-container" class="topologygraph"></div></div>
        </div>
        <div id="navigation" style="color: #ccc"></div>
        <script src="/d3.js"></script>
        <script>window.Icinga = {availableModules: {}};</script>
        <script src="/module.js"></script>
        <script>
          window.cg = Object.create(Icinga.availableModules.topologygraph.prototype);
          cg.onRenderedContainer();
        </script>
    </body></html>`;

    await page.route(ORIGIN + '/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === PAGE + '/index/data') {
            server.fetches++;
            if (server.fail) return route.fulfill({status: 500, body: 'failed'});
            return route.fulfill({contentType: 'application/json', body: JSON.stringify(server.data)});
        }
        if (url.pathname === '/d3.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: fs.readFileSync(path.join(ROOT, 'public/js/vendor/d3js.org_d3.v6.min.js'))
            });
        }
        if (url.pathname === '/module.js') {
            return route.fulfill({
                contentType: 'text/javascript',
                body: fs.readFileSync(path.join(ROOT, 'public/js/module.js'))
            });
        }
        return route.fulfill({contentType: 'text/html', body: html});
    });

    if (clock) await page.clock.install();
    await page.goto(ORIGIN + PAGE + query);
    await settle(page, clock);

    return {browser, page, server, errors, close: () => browser.close()};
}

/** Let the first fetch, layout and fit finish */
async function settle(page, clock = false) {
    if (clock) await page.clock.runFor(500);
    await page.waitForSelector('.topologygraph-viewport svg a', {timeout: 10000}).catch(() => {});
    await page.waitForTimeout(400);
}

/** The current zoom transform: {x, y, k} */
function transform(page) {
    return page.evaluate(() => {
        const value = document.querySelector('.topologygraph-viewport svg > g').getAttribute('transform') || '';
        const match = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(value);
        return match ? {x: +match[1], y: +match[2], k: +match[3]} : {x: 0, y: 0, k: 1};
    });
}

/**
 * Layout measurements taken from the drawn SVG:
 * hosts and arrows drawn, crossings between arrows, arrows running through a
 * box or label they don't belong to, and how many arrows are horizontal.
 */
function metrics(page) {
    return page.evaluate(() => {
        const svg = document.querySelector('.topologygraph-viewport svg');
        const arrows = [...svg.querySelectorAll('path[marker-end]')].map(element => {
            const n = element.getAttribute('d').match(/-?[\d.]+(e-?\d+)?/g).map(Number);
            return {s: {x: n[0], y: n[1]}, t: {x: n[n.length - 2], y: n[n.length - 1]}};
        });
        const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
        const yAt = (e, x) => e.s.y + (e.t.y - e.s.y) * (x - e.s.x) / (e.t.x - e.s.x);
        let crossings = 0;
        for (let i = 0; i < arrows.length; i++) {
            for (let j = i + 1; j < arrows.length; j++) {
                const a = arrows[i], b = arrows[j];
                if (same(a.s, b.s) || same(a.t, b.t)) continue;
                const lo = Math.max(Math.min(a.s.x, a.t.x), Math.min(b.s.x, b.t.x));
                const hi = Math.min(Math.max(a.s.x, a.t.x), Math.max(b.s.x, b.t.x));
                if (hi - lo < 1) continue;
                if ((yAt(a, lo) - yAt(b, lo)) * (yAt(a, hi) - yAt(b, hi)) < 0) crossings++;
            }
        }
        const finite = arrows.every(e => [e.s.x, e.s.y, e.t.x, e.t.y].every(Number.isFinite));
        return {
            hosts: svg.querySelectorAll('a').length,
            arrows: arrows.length,
            boxes: svg.querySelectorAll('rect').length,
            crossings,
            horizontal: arrows.filter(e => Math.abs(e.s.y - e.t.y) < 1).length,
            finite
        };
    });
}

/** Names of the hosts currently drawn */
function drawnHosts(page) {
    return page.$$eval('.topologygraph-viewport svg a text', texts => texts.map(t => t.textContent).sort());
}

module.exports = {open, settle, fixture, transform, metrics, drawnHosts, ORIGIN, PAGE};
