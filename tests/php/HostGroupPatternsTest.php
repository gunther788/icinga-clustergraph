<?php

/**
 * Tests for HostGroupPatterns. Run with: php tests/php/HostGroupPatternsTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Topologygraph\Common\HostGroupPatterns;

$patterns = new HostGroupPatterns("synthetic\n app-* \r\ndc-?-backend, !*-test\n\n!\napp-*");

check('exact name', $patterns->matches('synthetic'), true);
check('* wildcard', $patterns->matches('app-shop'), true);
check('? matches exactly one character', [$patterns->matches('dc-1-backend'), $patterns->matches('dc-12-backend')], [true, false]);
check('! excludes', $patterns->matches('app-shop-test'), false);
check('not listed', $patterns->matches('linux-servers'), false);
check('case-sensitive, like Icinga', $patterns->matches('Synthetic'), false);
check('regex characters are literal', (new HostGroupPatterns('a.b'))->matches('axb'), false);
check('only exclusions offer nothing', (new HostGroupPatterns('!foo'))->isEmpty(), true);

check('API filter: match() per pattern, exclusions negated', $patterns->apiFilter(), [
    'filter' => '(match(include0, hostgroup.name) || match(include1, hostgroup.name) || match(include2, hostgroup.name))'
        . ' && !(match(exclude0, hostgroup.name))',
    'filter_vars' => ['include0' => 'synthetic', 'include1' => 'app-*', 'include2' => 'dc-?-backend', 'exclude0' => '*-test']
]);

$requests = [];
$api = function ($endpoint, $body) use (&$requests) {
    $requests[] = $endpoint;
    return [
        ['name' => 'app-shop', 'attrs' => ['display_name' => 'Shop']],
        ['name' => 'app-crm-test', 'attrs' => ['display_name' => 'CRM test']], // the API should have left this out
        ['name' => 'app-blog', 'attrs' => []]
    ];
};
check('offered: matches sorted, default first when not among them', $patterns->offered($api, 'probes'), [
    ['name' => 'probes', 'label' => 'probes'],
    ['name' => 'app-blog', 'label' => 'app-blog'],
    ['name' => 'app-shop', 'label' => 'Shop']
]);
check('offered: asks for host groups', $requests, ['objects/hostgroups?attrs=name&attrs=display_name']);
check('offered: default among the matches is not repeated',
    array_column($patterns->offered($api, 'app-shop'), 'name'), ['app-blog', 'app-shop']);

$requests = [];
check('no patterns: only the default, no request', [(new HostGroupPatterns(''))->offered($api, 'synthetic'), $requests],
    [[['name' => 'synthetic', 'label' => 'synthetic']], []]);

// --- choose() -----------------------------------------------------------------

$asked = 0;
$offeredNames = function () use (&$asked) {
    $asked++;
    return ['probes', 'app-blog', 'app-shop'];
};
check('choose: nothing asked for graphs the default, without listing groups',
    [$patterns->choose([], 'probes', $offeredNames), $asked], [[['probes'], []], 0]);
check('choose: offered groups graphed, others ignored', $patterns->choose(['app-shop', 'nope', ' app-blog ', 'app-shop'], 'probes', $offeredNames),
    [['app-shop', 'app-blog'], ['nope']]);
check('choose: none offered falls back to the default', $patterns->choose(['nope'], 'probes', $offeredNames),
    [['probes'], ['nope']]);
check('choose: without patterns only the default', (new HostGroupPatterns(''))->choose(['probes', 'app-shop'], 'probes', $offeredNames),
    [['probes'], ['app-shop']]);

finish();
