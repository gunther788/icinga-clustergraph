# Tests

Two sets of tests, both run from this folder:

- **PHP** (`php/GraphBuilderTest.php`): checks how API results are turned into the graph data.
  This covers which hosts and links are selected, the service summaries, and the unreachable,
  acknowledged and downtime flags. Plain PHP, no framework.
- **Browser** (`browser/*.test.js`): opens the real `module.js` and compiled `module.less` in headless Chromium.
  The page mimics Icinga Web's layout and uses a fake data endpoint. These tests cover layout quality, window
  filling, zoom and pan, live updates, the host picker and URL, status colours and hover highlighting. They use
  Node's built-in test runner with Playwright.

The sample graphs are in `fixtures/`.

## Running

Needs PHP and Node.js 18 or later.

```bash
cd tests
npm install
npx playwright install chromium
npm test
```

`npm run test:php` and `npm run test:browser` run one set each.

The layout tests have limits for crossing and horizontal arrows on each sample, in `browser/layout.test.js`. A failure there means a change made the layout worse. When the layout improves, tighten the limits.

## Comparing layout engines

`npm run compare` prints measurements for the standard, ELK and hybrid layouts on each sample graph:

- crossing arrows;
- arrows through boxes or labels;
- level arrows;
- the drawing's size and the zoom it fits at.

To compare them on your own hosts, save the output of `…/topologygraph/index/data` (while logged in to Icinga Web) to a file and pass it:

```bash
npm run compare -- my-graph.json
npm run compare -- my-graph.json --size=1920x1080
```

