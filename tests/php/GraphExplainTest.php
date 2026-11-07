<?php

/**
 * Tests for GraphExplain. Run with: php tests/php/GraphExplainTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\GraphExplain;

function node($name, $member, array $groups = [])
{
    return ['name' => $name, 'label' => strtoupper($name), 'synthetic' => $member, 'groups' => $groups];
}

// probe-a (member) -> web-1 -> db-1 (an outside link), probe-a -> app-1
$graph = [
    'nodes' => [
        node('probe-a', true, ['synthetic']),
        node('web-1', false, ['web']),
        node('db-1', false, ['web', 'db']),
        node('app-1', false, [])
    ],
    'links' => [
        ['source' => 'probe-a', 'target' => 'web-1'],
        ['source' => 'web-1', 'target' => 'db-1'],
        ['source' => 'probe-a', 'target' => 'app-1']
    ]
];

$requests = [];
$api = function ($endpoint, $body) use (&$requests) {
    $requests[] = $body;
    if (strpos($endpoint, 'objects/hosts') === 0) {
        if ($body['filter'] === 'group in host.groups') {
            return $body['filter_vars']['group'] === 'web' ? [
                ['name' => 'web-1', 'attrs' => ['groups' => ['web']]],
                ['name' => 'db-1', 'attrs' => ['groups' => ['web', 'db']]],
                ['name' => 'web-2', 'attrs' => ['display_name' => 'Web 2', 'groups' => ['web']]],
                ['name' => 'web-3', 'attrs' => ['groups' => ['web']]]
            ] : [];
        }
        // by name: 'lonely' exists, 'ghost' doesn't
        return in_array('lonely', $body['filter_vars']['names'], true)
            ? [['name' => 'lonely', 'attrs' => ['groups' => []]]] : [];
    }
    // dependencies of the hosts not drawn
    return [
        ['attrs' => ['parent_host_name' => 'db-1', 'child_host_name' => 'web-2', 'child_service_name' => '']],
        ['attrs' => ['parent_host_name' => 'nowhere', 'child_host_name' => 'web-3', 'child_service_name' => '']]
    ];
};

$x = GraphExplain::explain($graph, 'synthetic', ['app-1', 'lonely', 'ghost'], ['web', 'typo'], $api);
$hosts = [];
foreach ($x['hosts'] as $h) {
    $hosts[$h['name']] = $h;
}

check('members first, then by name', array_column($x['hosts'], 'name'), ['probe-a', 'app-1', 'db-1', 'web-1']);
check('drawn as member or outside', array_column($x['hosts'], 'drawn_as'), ['member', 'outside', 'outside', 'outside']);
check('why a member is drawn', $hosts['probe-a']['why_drawn'], ['in the synthetic host group']);
check('why a neighbour is drawn', $hosts['web-1']['why_drawn'], ['child of probe-a']);
check('a host drawn only through outside links has no member reason', $hosts['db-1']['why_drawn'], []);
check('shown: selected by name, by group, and parents above', [
    $hosts['app-1']['why_shown'], $hosts['db-1']['why_shown'], $hosts['probe-a']['shown']
], [['selected by name'], ['in selected host group web'], true]);
check('links: which request found them', array_column($x['links'], 'found'),
    ['touches a member', 'between two outside hosts', 'touches a member']);
check('group report: drawn hosts, and how', [
    $x['hostgroups']->web['drawn_as_member'], $x['hostgroups']->web['drawn_outside'], $x['hostgroups']->web['not_drawn']
], [[], ['db-1', 'web-1'], ['web-2', 'web-3']]);
check('unknown group gets a note', isset($x['hostgroups']->typo['note']), true);
$missing = [];
foreach ($x['selected_but_not_drawn'] as $m) {
    $missing[$m['name']] = $m;
}
check('not drawn: group members and named hosts', array_keys($missing), ['lonely', 'web-2', 'web-3', 'ghost']);
check('not drawn: connected only to an outside host',
    strpos($missing['web-2']['reason'], 'outside the synthetic host group (db-1)') !== false, true);
check('not drawn: dependencies listed', $missing['web-2']['host_dependencies'], [['parent' => 'db-1', 'child' => 'web-2']]);
check('not drawn: dependencies leading nowhere drawn',
    strpos($missing['web-3']['reason'], 'none of its host-to-host dependencies') !== false, true);
check('not drawn: no dependencies', strpos($missing['lonely']['reason'], 'no host-to-host dependencies at all') !== false, true);
check('not drawn: unknown host', $missing['ghost']['reason'], 'Icinga has no host with this name');
check('counts', $x['counts'], [
    'drawn' => 4, 'drawn_as_member' => 1, 'drawn_outside' => 3, 'links' => 3, 'shown' => 4, 'selected_but_not_drawn' => 4
]);

// No selection: no extra requests, everything shown
$requests = [];
$plain = GraphExplain::explain($graph, 'synthetic', [], [], $api);
check('no selection: no API requests', $requests, []);
check('no selection: everything shown', array_unique(array_column($plain['hosts'], 'shown')), [true]);

finish();
