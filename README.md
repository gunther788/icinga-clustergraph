# ClusterGraph for Icinga Web 2: synthetic host topology

This is a fork of [sol1/icinga-clustergraph](https://github.com/sol1/icinga-clustergraph). The original module draws
the Icinga 2 cluster: zones, the endpoints in each zone, and which zone reports to which parent.

This fork keeps the module's name, menu entry, configuration and API plumbing, but uses them to draw something else
entirely: a **parent/child topology graph of the hosts in the `synthetic` host group**. Zones and endpoints are no
longer shown.

## How the module was repurposed

The upstream module asks the Icinga 2 API for zones and endpoints and draws them as a tree. This fork swaps both ends:

- **Data:** `IndexController::dataAction()` asks the API for hosts and `Dependency` objects instead of zones. It
  returns every host in the `synthetic` host group, plus any direct parent or child of one that is outside the group,
  and the parent → child links between them. Only host-to-host dependencies are used; service dependencies are ignored.
- **Drawing:** `public/js/module.js` replaces the zone tree with a layered dependency graph built with D3, described
  below.
- **Permissions:** the API user needs `objects/query/Host` and `objects/query/Dependency` instead of the zone and
  endpoint permissions.

Everything else (installation, the module settings page, the `clustergraph` URL and menu entry) works as before.

## What the graph shows

- **Layout:** parents are on the right and children on the left. Each arrow points from a parent to its child.
- **Rightmost column:** hosts with no parents (typically the synthetic checks themselves) form the rightmost level.
  Hosts that are parents of exactly the same children are drawn together in one rounded box with a single exit point
  for their arrows. That column is wrapped into several side-by-side sub-columns, so a long list of checks doesn't
  make the graph very tall.
- **Colours:** dots and names show host state: green for up, red for down, blue for pending, grey for unknown.
  Arrows into a host that is down are red too.
- **Hosts outside the group:** they're drawn faded and in italics. Hover over any host for its name, state and zone,
  and click it to open the host in Icinga Web.

The layout tries to:

- keep arrows horizontal, by lining each host up with one of the hosts it connects to;
- cross as few arrows as possible, and avoid running arrows through boxes or host names;
- match the shape of the browser window, so the diagram fills it at full text size.

## Using it

- **Moving around:**
  - Drag to move the diagram.
  - Pinch, or hold Ctrl (⌘ on a Mac) and scroll, to zoom.
  - Plain scrolling moves the diagram until it reaches an edge, then scrolls the page.
- **Buttons** (top right): zoom in, zoom out, **Fit** (the whole diagram), **1:1** (100%) and **Full screen** (Esc to
  leave).
- **Showing a subset:** the host button (it reads **All hosts ▾** until you choose) opens a checklist of every host
  without children, with a filter box. Tick one or more hosts to show only them and everything above them: their
  parents, their parents' parents, and so on. **Show all** goes back to everything.
- **Bookmarking a subset:** the selection is kept in the page address as repeated `host` parameters. Bookmark or
  share it like any other link, for example:

  ```
  https://icinga.example.com/icingaweb2/clustergraph?host=db-1&host=cache-1
  ```

- **Live updates:** while the page is visible, the graph fetches fresh data every 15 seconds and catches up straight
  away when you return to the tab. A change of host state only recolours the existing drawing, so your zoom and
  position stay put. If hosts or dependencies were added or removed, the graph is laid out again. The bottom-right
  corner shows when it last updated.

## Prerequisites

- Icinga Web 2, with the icinga-php-library (0.11.0 or later)
- Icinga 2 with the REST API enabled and an API user (see below)
- A host group named `synthetic`
- Host parent/child relationships defined as Icinga 2 `Dependency` objects

The graph is built from `Dependency` objects only. If your parents are kept in a custom variable, add an apply rule
that turns it into dependencies, for example:

```
apply Dependency "host-parent" for (parent in host.vars.parents) to Host {
  parent_host_name = parent
  assign where host.vars.parents
}
```

## Installation

1. Clone this fork into the Icinga Web 2 `modules` directory as `clustergraph`:

   ```
   git clone https://github.com/gunther788/icinga-clustergraph.git /usr/share/icingaweb2/modules/clustergraph
   ```

2. Enable the module in the Icinga Web 2 web interface, or on the command line:

   ```
   icingacli module enable clustergraph
   ```

## Configuration

1. Add an API user to Icinga 2, for example in `api-users.conf`:

   ```
   object ApiUser "clustergraph" {
     password = "change-me"
     permissions = [ "objects/query/Host", "objects/query/Dependency" ]
   }
   ```

2. In Icinga Web 2, go to **Configuration → Modules → clustergraph → Config**.
3. Enter the API user, password, endpoint (host name) and port, and choose the web interface your host links should
   open in: Icinga Web 2 (monitoring) or Icinga DB Web.
4. Save the changes, then open **ClusterGraph** from the menu.

## Adjusting it

These are constants in the code rather than settings:

- **Host group:** `synthetic`, in `application/controllers/IndexController.php`.
- **Refresh interval:** `REFRESH_MS` (15 seconds), near the top of `public/js/module.js`.
- **Font size and base spacing:** `FONT_SIZE` and `BASE`, also in `public/js/module.js`.

## Limitations

- On very large graphs (more than 400 arrows) the slower layout refinements are skipped to keep the page
  responsive, so the layout may be less tidy.
- Only one arrow into a host can be level when its parents sit at different heights, so graphs where most hosts have
  several parents will still have sloped arrows.
- On touch devices, dragging on the graph moves the diagram instead of scrolling the page.

## Contributing

Changes to this fork go to https://github.com/gunther788/icinga-clustergraph. The original zone and endpoint graph
lives upstream at https://github.com/sol1/icinga-clustergraph.

## License

All code here is licensed under GPL V2.
