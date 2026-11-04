(function (Icinga) {


    var Clustergraph = function (module) {
        this.module = module;
        this.initialize();
        this.module.icinga.logger.debug('Clustergraph module loaded');
    };

    function rgbToHex(rgb) {
        const match = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!match) {
            return null;
        }
        const toHex = (n) => ('0' + parseInt(n).toString(16)).slice(-2);
        return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
    }

    function stateColor(node) {
        if (node.state === null || node.state === undefined) return "#dbdbdb"; // unknown host
        if (!node.last_check || node.last_check <= 0) return "#77aaff";        // Pending
        if (node.state === 0) return "#44bb77";                                // Up
        if (node.state === 1) return "#ff5566";                                // Down
        return "#dbdbdb";
    }

    function stateName(node) {
        if (node.state === null || node.state === undefined) return "unknown";
        if (!node.last_check || node.last_check <= 0) return "pending";
        return node.state === 0 ? "up" : "down";
    }

    /**
     * Lay out a directed acyclic graph in columns (parents left, children right).
     *
     * Each node's column is the length of the longest parent chain above it, so a
     * host with several parents always sits to the right of all of them. Rows are
     * ordered with a few barycenter sweeps to reduce crossing edges.
     */
    function layout(nodes, links) {
        const byName = new Map(nodes.map(n => [n.name, n]));
        const parents = new Map(nodes.map(n => [n.name, []]));
        const children = new Map(nodes.map(n => [n.name, []]));
        const indegree = new Map(nodes.map(n => [n.name, 0]));

        links.forEach(l => {
            if (!byName.has(l.source) || !byName.has(l.target)) return;
            children.get(l.source).push(l.target);
            parents.get(l.target).push(l.source);
            indegree.set(l.target, indegree.get(l.target) + 1);
        });

        // Longest-path layering via Kahn's topological sort
        const layer = new Map(nodes.map(n => [n.name, 0]));
        const queue = nodes.filter(n => indegree.get(n.name) === 0).map(n => n.name);
        const seen = new Set();
        while (queue.length) {
            const name = queue.shift();
            seen.add(name);
            children.get(name).forEach(child => {
                layer.set(child, Math.max(layer.get(child), layer.get(name) + 1));
                indegree.set(child, indegree.get(child) - 1);
                if (indegree.get(child) === 0) queue.push(child);
            });
        }
        // Icinga rejects dependency cycles, but don't hang or drop nodes if one slips through
        nodes.forEach(n => {
            if (!seen.has(n.name)) {
                const maxParent = Math.max(-1, ...parents.get(n.name).filter(p => seen.has(p)).map(p => layer.get(p)));
                layer.set(n.name, maxParent + 1);
            }
        });

        const layerCount = Math.max(0, ...layer.values()) + 1;
        const columns = Array.from({length: layerCount}, () => []);
        nodes
            .slice()
            .sort((a, b) => d3.ascending(a.label, b.label))
            .forEach(n => columns[layer.get(n.name)].push(n.name));

        const position = new Map();
        const reindex = () => columns.forEach(col => col.forEach((name, i) => position.set(name, i)));
        reindex();

        const barycenter = (name, neighbours) => {
            const list = neighbours.get(name);
            if (!list.length) return position.get(name);
            return d3.mean(list, n => position.get(n));
        };

        for (let sweep = 0; sweep < 4; sweep++) {
            for (let i = 1; i < layerCount; i++) {
                columns[i].sort((a, b) => barycenter(a, parents) - barycenter(b, parents));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
            for (let i = layerCount - 2; i >= 0; i--) {
                columns[i].sort((a, b) => barycenter(a, children) - barycenter(b, children));
                columns[i].forEach((name, idx) => position.set(name, idx));
            }
        }

        return {columns, layer, position, layerCount};
    }

    Clustergraph.prototype = {

        initialize: function () {
            this.module.on('rendered', this.onRenderedContainer);
        },

        chart: function (data) {
            const navigation = document.getElementById("navigation");
            const textColor = (navigation && rgbToHex(getComputedStyle(navigation).getPropertyValue('color').trim())) || "#535353";

            const nodes = data.nodes || [];
            const links = data.links || [];

            if (!nodes.length) {
                const empty = document.createElement('p');
                empty.textContent = 'No hosts found in the "synthetic" host group.';
                return empty;
            }

            const {columns, layer, position, layerCount} = layout(nodes, links);

            const fontSize = 11;    // about 80% of the original 14px
            const rowHeight = 24;
            const padding = 16;
            const labelOffset = 10; // circle centre to the end of its label (labels sit left of the dot)
            const columnGap = 90;   // space for the edges between dependency levels
            const subColumnGap = 40; // space between the wrapped parts of the rightmost column

            // Measure labels so each column leaves room for its text
            const ctx = document.createElement("canvas").getContext("2d");
            const labelWidth = new Map(nodes.map(n => {
                ctx.font = (n.synthetic ? "bold" : "italic") + " " + fontSize + "px sans-serif";
                return [n.name, ctx.measureText(n.label).width];
            }));

            // A slot is one drawn column: a list of {name, row} plus its height in rows.
            // Children on the left, parents on the right, so slots run from the
            // deepest layer to layer 0.
            const slots = [];
            for (let col = layerCount - 1; col >= 1; col--) {
                slots.push({
                    items: columns[col].map(name => ({name, row: position.get(name)})),
                    height: columns[col].length,
                    gapAfter: columnGap
                });
            }

            // The rightmost column (hosts with no parents) is usually by far the
            // tallest, so wrap it into several side-by-side sub-columns. Hosts that
            // are parents of the same children are kept together as a group, with
            // a blank row between groups; hosts with no children go last.
            const childrenOf = new Map(nodes.map(n => [n.name, []]));
            links.forEach(l => {
                if (childrenOf.has(l.source)) childrenOf.get(l.source).push(l.target);
            });
            const groups = new Map();
            columns[0].forEach(name => {
                const key = childrenOf.get(name).slice().sort().join("\0");
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(name);
            });
            const orderedGroups = [...groups.entries()]
                .sort((a, b) => (a[0] === "") - (b[0] === ""))
                .map(entry => entry[1]);

            const otherMax = Math.max(0, ...slots.map(slot => slot.height));
            const target = layerCount > 1
                ? Math.max(otherMax, 8)
                : Math.max(8, Math.ceil(columns[0].length / 4));

            const wrapped = [];
            let current = {items: [], height: 0, gapAfter: subColumnGap};
            orderedGroups.forEach(group => {
                if (current.items.length && current.height + 1 + group.length > target) {
                    wrapped.push(current);
                    current = {items: [], height: 0, gapAfter: subColumnGap};
                }
                if (current.items.length) current.height += 1; // blank row between groups
                group.forEach(name => {
                    if (current.height >= target) { // a single group taller than the target
                        wrapped.push(current);
                        current = {items: [], height: 0, gapAfter: subColumnGap};
                    }
                    current.items.push({name, row: current.height++});
                });
            });
            if (current.items.length) wrapped.push(current);
            slots.push(...wrapped);

            // Horizontal placement: each slot is as wide as its longest label
            // (drawn left of the dot) plus the gap that follows it.
            let x = padding;
            slots.forEach(slot => {
                x += Math.max(0, ...slot.items.map(item => labelWidth.get(item.name))) + labelOffset;
                slot.x = x;
                x += slot.gapAfter;
            });
            const lastGap = slots.length ? slots[slots.length - 1].gapAfter : 0;

            // Centre each slot vertically against the tallest one
            const maxRows = Math.max(1, ...slots.map(slot => slot.height));
            const coords = new Map();
            slots.forEach(slot => {
                const offset = (maxRows - slot.height) * rowHeight / 2;
                slot.items.forEach(item => coords.set(item.name, {
                    x: slot.x,
                    y: padding + offset + item.row * rowHeight
                }));
            });
            const point = name => coords.get(name);

            // Edges leave from the far (left) end of the parent's label and run left
            // into the child's dot from the right.
            const edgeStart = name => {
                const p = point(name);
                return {x: p.x - labelOffset - labelWidth.get(name) - 5, y: p.y};
            };

            const width = x - lastGap + padding;
            const height = padding * 2 + (maxRows - 1) * rowHeight + 8;

            // Edges from the outer sub-columns pass behind inner labels, so outline
            // the text in the page background colour to keep it readable.
            let background = null;
            for (let el = document.getElementById("clustergraph-container"); el; el = el.parentElement) {
                const bg = getComputedStyle(el).backgroundColor;
                if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
                    background = bg;
                    break;
                }
            }

            const svg = d3.create("svg")
                .attr("width", width)
                .attr("height", height)
                .attr("viewBox", [0, 0, width, height])
                .attr("style", "max-width: 100%; height: auto; font: " + fontSize + "px sans-serif;");

            svg.append("defs").append("marker")
                .attr("id", "clustergraph-arrow")
                .attr("viewBox", "0 -5 10 10")
                .attr("refX", 13)
                .attr("refY", 0)
                .attr("markerWidth", 6)
                .attr("markerHeight", 6)
                .attr("orient", "auto")
                .append("path")
                .attr("d", "M0,-5L10,0L0,5")
                .attr("fill", "#00c3ed");

            const nodeNames = new Set(nodes.map(n => n.name));
            const drawnLinks = links.filter(l => nodeNames.has(l.source) && nodeNames.has(l.target));

            svg.append("g")
                .attr("fill", "none")
                .attr("stroke", "#00c3ed")
                .attr("stroke-opacity", 0.5)
                .attr("stroke-width", 1.6)
                .selectAll("path")
                .data(drawnLinks)
                .join("path")
                .attr("marker-end", "url(#clustergraph-arrow)")
                .attr("d", d3.linkHorizontal()
                    .source(l => edgeStart(l.source))
                    .target(l => point(l.target))
                    .x(p => p.x)
                    .y(p => p.y));

            const node = svg.append("g")
                .selectAll("a")
                .data(nodes)
                .join("a")
                .attr("href", d => d.link)
                .attr("transform", d => {
                    const p = point(d.name);
                    return `translate(${p.x},${p.y})`;
                });

            node.append("title")
                .text(d => [
                    d.name,
                    "state: " + stateName(d),
                    d.zone ? "zone: " + d.zone : null,
                    d.synthetic ? null : "not in the synthetic host group"
                ].filter(Boolean).join("\n"));

            node.append("circle")
                .attr("r", 5)
                .attr("fill", d => stateColor(d))
                .attr("stroke", d => d.synthetic ? "none" : textColor)
                .attr("stroke-dasharray", "2,2");

            node.append("text")
                .attr("x", -labelOffset)
                .attr("dy", "0.32em")
                .attr("text-anchor", "end")
                .attr("fill", d => d.synthetic ? stateColor(d) : textColor)
                .attr("opacity", d => d.synthetic ? 1 : 0.6)
                .attr("font-weight", d => d.synthetic ? "bold" : "normal")
                .attr("font-style", d => d.synthetic ? "normal" : "italic")
                .attr("stroke", background || "none")
                .attr("stroke-width", 3)
                .attr("stroke-linejoin", "round")
                .attr("paint-order", "stroke")
                .text(d => d.label);

            return svg.node();
        },


        onRenderedContainer: function (event) {
            const container = document.getElementById('clustergraph-container');
            // in module configuration we don't have a graph, so return peacefully
            if (!container) {
                return;
            }

            fetch(window.location.pathname + "/index/data")
                .then(response => response.json())
                .then(data => {
                    container.replaceChildren(this.chart(data));
                });


        }
    };

    Icinga.availableModules.clustergraph = Clustergraph;

}(Icinga));
