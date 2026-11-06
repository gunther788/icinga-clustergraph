/**
 * Compare the standard and ELK layouts on the sample graphs, or on your own
 * graph data, and print the measurements.
 *
 *     npm run compare                      # the samples in fixtures/
 *     npm run compare -- my-graph.json     # graph data saved from .../index/data
 *
 * Options: --size=WIDTHxHEIGHT (window size, default 1400x800).
 */
const fs = require('fs');
const path = require('path');
const {open, fixture, routeMetrics} = require('./browser/harness');

const args = process.argv.slice(2);
const sizeArg = args.find(a => a.startsWith('--size='));
const [width, height] = (sizeArg ? sizeArg.slice(7) : '1400x800').split('x').map(Number);
const files = args.filter(a => !a.startsWith('--'));
const graphs = files.length
    ? files.map(file => [path.basename(file), JSON.parse(fs.readFileSync(file, 'utf8'))])
    : ['small', 'parents23', 'random40'].map(name => [name, fixture(name)]);

(async () => {
    const rows = [];
    for (const [name, data] of graphs) {
        for (const layout of ['standard', 'elk']) {
            const started = Date.now();
            const o = await open({data, viewport: {width, height}, query: layout === 'elk' ? '?layout=elk' : ''});
            if (layout === 'elk') {
                await o.page.waitForFunction(() => {
                    const paths = document.querySelectorAll('.topologygraph-viewport svg path[marker-end]');
                    return paths.length && [...paths].every(p => !p.getAttribute('d').includes('C'));
                }, null, {timeout: 60000}).catch(() => {});
            }
            const m = await routeMetrics(o.page);
            rows.push({
                graph: name, layout, hosts: data.nodes.length, ...m,
                'ready (s)': ((Date.now() - started) / 1000).toFixed(1),
                errors: o.errors.length
            });
            await o.close();
        }
    }
    console.table(rows);
})();
