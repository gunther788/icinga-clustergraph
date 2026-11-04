<?php

namespace Icinga\Module\Clustergraph\Common;

/**
 * A small file cache for the graph data, so several people with the page open
 * share one set of API requests. Entries are JSON files in a directory, valid
 * for a number of seconds from when they were written. Failures to read or
 * write the cache are ignored: the value is then simply computed again.
 */
final class JsonCache
{
    private $directory;

    /** @var callable Returns the current time; replaceable in tests */
    private $clock;

    public function __construct($directory, ?callable $clock = null)
    {
        $this->directory = rtrim($directory, DIRECTORY_SEPARATOR);
        $this->clock = $clock ?: 'time';
    }

    /**
     * Return the cached value for $key if it is younger than $ttl seconds,
     * otherwise compute it with $compute, store it and return it. Exceptions
     * from $compute are passed on and nothing is stored.
     */
    public function remember($key, $ttl, callable $compute)
    {
        $file = $this->directory . DIRECTORY_SEPARATOR . sha1($key) . '.json';
        $now = call_user_func($this->clock);

        if ($ttl > 0 && is_file($file)) {
            $entry = json_decode((string) @file_get_contents($file), true);
            if (is_array($entry) && isset($entry['time']) && $now - $entry['time'] < $ttl) {
                return $entry['value'];
            }
        }

        $value = $compute();

        if ($ttl > 0) {
            if (! is_dir($this->directory)) {
                @mkdir($this->directory, 0700, true);
            }
            // Write to a temporary file and rename, so readers never see half a file
            $temporary = $file . '.' . getmypid() . '.tmp';
            if (@file_put_contents($temporary, json_encode(['time' => $now, 'value' => $value])) !== false) {
                @rename($temporary, $file);
            }
        }

        return $value;
    }
}
