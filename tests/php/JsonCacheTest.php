<?php

/**
 * Tests for JsonCache. Run with: php tests/php/JsonCacheTest.php
 */

require __DIR__ . '/lib.php';

use Icinga\Module\Clustergraph\Common\JsonCache;

$directory = sys_get_temp_dir() . '/clustergraph-cache-test-' . getmypid();
$now = 1000;
$cache = new JsonCache($directory, function () use (&$now) {
    return $now;
});
$calls = 0;
$compute = function () use (&$calls) {
    $calls++;
    return ['nodes' => [['name' => '123']], 'call' => $calls];
};

$first = $cache->remember('key', 7, $compute);
check('first call computes', [$calls, $first['call']], [1, 1]);

$now = 1006;
$second = $cache->remember('key', 7, $compute);
check('within the TTL the cached value is returned', [$calls, $second], [1, $first]);
check('values round-trip unchanged', $second['nodes'][0]['name'], '123');

$now = 1007;
$third = $cache->remember('key', 7, $compute);
check('after the TTL it is computed again', [$calls, $third['call']], [2, 2]);

$cache->remember('other key', 7, $compute);
check('keys are separate', $calls, 3);

$cache->remember('key', 0, $compute);
check('TTL 0 never caches', $calls, 4);

$thrown = null;
try {
    $cache->remember('failing', 7, function () {
        throw new \RuntimeException('API down');
    });
} catch (\RuntimeException $e) {
    $thrown = $e->getMessage();
}
check('exceptions are passed on', $thrown, 'API down');
$cache->remember('failing', 7, $compute);
check('and nothing was cached for them', $calls, 5);

$unwritable = new JsonCache('/proc/clustergraph-not-writable');
check('an unusable cache directory still returns the value', $unwritable->remember('k', 7, function () {
    return 42;
}), 42);

array_map('unlink', glob($directory . '/*'));
rmdir($directory);
finish();
