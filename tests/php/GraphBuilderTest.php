<?php

/**
 * Tests for GraphBuilder. Plain PHP, no framework: run with
 *
 *     php tests/php/GraphBuilderTest.php
 *
 * Exits non-zero if any check fails.
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Clustergraph\Common\GraphBuilder;

function host($name, array $attrs = [])
{
    return ['name' => $name, 'attrs' => $attrs + ['display_name' => $name, 'groups' => []]];
}

function dependency($parent, $child, $childService = '')
{
    return ['attrs' => [
        'parent_host_name' => $parent, 'child_host_name' => $child, 'child_service_name' => $childService
    ]];
}

function service($host, $state, array $attrs = [])
{
    return ['attrs' => $attrs + ['host_name' => $host, 'state' => $state, 'last_check' => 1000]];
}

// --- select() ---------------------------------------------------------------

$hosts = [
    host('probe-a', ['groups' => ['synthetic']]),
    host('probe-b', ['groups' => ['synthetic', 'other']]),
    host('fw-1'),
    host('db-1'),
    host('unrelated'),
    host('123', ['groups' => ['synthetic']]) // numeric name
];
$dependencies = [
    dependency('fw-1', 'probe-a'),    // non-synthetic parent of a synthetic host
    dependency('probe-b', 'db-1'),    // non-synthetic child of a synthetic host
    dependency('fw-1', 'unrelated'),  // touches no synthetic host: ignored
    dependency('fw-1', 'probe-a'),    // duplicate: kept once
    dependency('probe-a', 'probe-a'), // self-loop: ignored
    dependency('db-1', 'probe-b', 'http'), // service dependency: ignored
];
$selection = GraphBuilder::select($hosts, $dependencies, 'synthetic');
$names = $selection['names'];
sort($names);

check('select: synthetic hosts plus their direct neighbours', $names, ['123', 'db-1', 'fw-1', 'probe-a', 'probe-b']);
check('select: numeric host names stay strings', in_array('123', $selection['names'], true), true);
check('select: only links touching synthetic hosts, without duplicates', $selection['links'], [
    ['source' => 'fw-1', 'target' => 'probe-a'],
    ['source' => 'probe-b', 'target' => 'db-1']
]);
check('select: group membership', array_map('strval', array_keys($selection['synthetic'])), ['probe-a', 'probe-b', '123']);

// --- summariseServices() ----------------------------------------------------

$summary = GraphBuilder::summariseServices([
    service('probe-a', 0),
    service('probe-a', 1),
    service('probe-a', 2, ['acknowledgement' => 1]), // handled critical
    service('probe-a', 3),
    service('probe-a', 0, ['last_check' => 0]),      // pending
    service('probe-b', 2, ['downtime_depth' => 1]),  // handled critical only
    service('db-1', 0)
]);

check('services: counts per state', [
    $summary['probe-a']['total'], $summary['probe-a']['ok'], $summary['probe-a']['warning'],
    $summary['probe-a']['critical'], $summary['probe-a']['unknown'], $summary['probe-a']['pending']
], [5, 1, 1, 1, 1, 1]);
check('services: worst state counts handled problems', $summary['probe-a']['worst'], 'critical');
check('services: worst unhandled state skips acknowledged ones', $summary['probe-a']['worst_unhandled'], 'unknown');
check('services: unhandled count', $summary['probe-a']['unhandled'], 2);
check('services: only handled problems leave no unhandled worst', [
    $summary['probe-b']['worst'], $summary['probe-b']['worst_unhandled'], $summary['probe-b']['unhandled']
], ['critical', null, 0]);
check('services: all OK', [$summary['db-1']['worst'], $summary['db-1']['unhandled']], ['ok', 0]);

// --- build() ----------------------------------------------------------------

$hosts[0]['attrs'] += ['state' => 1, 'last_check' => 5, 'last_reachable' => false, 'zone' => 'z1'];
$hosts[1]['attrs'] += ['state' => 1, 'last_check' => 5, 'last_reachable' => true, 'acknowledgement' => 1];
$hosts[2]['attrs'] += ['state' => 1, 'last_check' => 5, 'downtime_depth' => 2];
$graph = GraphBuilder::build($selection, $hosts, [service('probe-a', 2)], '/icingaweb2/icingadb/host?name=');
$byName = [];
foreach ($graph['nodes'] as $node) {
    $byName[$node['name']] = $node;
}

check('build: one node per selected host', count($graph['nodes']), 5);
check('build: unreachable host', [$byName['probe-a']['reachable'], $byName['probe-a']['zone']], [false, 'z1']);
check('build: acknowledged host', [$byName['probe-b']['acknowledged'], $byName['probe-b']['in_downtime']], [true, false]);
check('build: host in downtime', [$byName['fw-1']['acknowledged'], $byName['fw-1']['in_downtime']], [false, true]);
check('build: service summary attached', $byName['probe-a']['services']['worst_unhandled'], 'critical');
check('build: host without services gets an empty summary', $byName['db-1']['services']['total'], 0);
check('build: link to the host page is URL-encoded', $byName['probe-a']['link'], '/icingaweb2/icingadb/host?name=probe-a');
check('build: links passed through', $graph['links'], $selection['links']);

$withoutServices = GraphBuilder::build($selection, $hosts, null, '/x?host=');
check('build: services null when they could not be fetched', $withoutServices['nodes'][0]['services'], null);

finish();
