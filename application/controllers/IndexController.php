<?php


namespace Icinga\Module\Topologygraph\Controllers;

error_reporting(E_ALL);
ini_set('display_errors', '1');

use Icinga\Application\Icinga;
use Icinga\Application\Logger;
use Icinga\Module\Topologygraph\Common\GraphSource;
use Icinga\Module\Topologygraph\Common\IcingaApi;
use Icinga\Module\Topologygraph\Common\JsonCache;
use Icinga\Web\Controller;

class IndexController extends Controller
{
    public function indexAction()
    {
        $config = \Icinga\Application\Config::module('topologygraph');

        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');


        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }

        $this->view->tabs = $this->getTabs();

    }

    /**
     * Serve the vendored ELK layout library (elkjs). It is large, so instead of
     * adding it to the script bundle Icinga Web loads on every page, the graph
     * page loads it from here only when the ELK layout is chosen.
     */
    public function elkAction()
    {
        $file = $this->Module()->getBaseDir() . '/public/js/vendor/elkjs/elk.bundled.js';
        if (! is_readable($file)) {
            $this->httpNotFound('ELK is not installed');
        }

        header('Content-Type: application/javascript; charset=utf-8');
        header('Content-Length: ' . filesize($file));
        header('Cache-Control: public, max-age=604800');
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', filemtime($file)) . ' GMT');
        readfile($file);
        exit;
    }

    public function testAction()
    {
        echo "Test Successful";
        exit;
    }


    public function dataAction()
    {
        // Configuration

        $config = \Icinga\Application\Config::module('topologygraph');
        $ICINGA_API_ENDPOINT = $config->get('api', 'host');
        $ICINGA_API_USER = $config->get('api', 'username');
        $ICINGA_API_PASSWORD = $config->get('api', 'password');
        $ICINGAWEB_TYPE = $config->get('graph', 'ui');
        
        $ICINGAWEB_BASEURL = Icinga::app()->getRequest()->getBaseUrl() . '/';
        if ($ICINGAWEB_TYPE == 'icingaweb2') {
            $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'monitoring/host/show?host=';
        } elseif ($ICINGAWEB_TYPE == 'icingadb') {
            $ICINGAWEB_HOST_PATH = $ICINGAWEB_BASEURL . 'icingadb/host?name=';  
        }
        

        if (!$ICINGA_API_ENDPOINT || !$ICINGA_API_USER || !$ICINGA_API_PASSWORD) {
            throw new \Exception("Please configure the module in module settings.");
        }


        // Host group to draw and refresh interval, from the module settings
        $group = trim((string) $config->get('graph', 'hostgroup', 'synthetic'));
        if ($group === '') {
            $group = 'synthetic';
        }
        $refresh = max(5, (int) $config->get('graph', 'refresh', 15));

        // Everyone looking at the graph gets the same data (one API user), so
        // share it for half the refresh interval: several open pages then cause
        // one set of API requests instead of one each
        $cache = new JsonCache(sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'icingaweb2-topologygraph');
        $cacheKey = json_encode([
            $ICINGA_API_ENDPOINT, $config->get('api', 'port'), $ICINGA_API_USER, $group, $ICINGAWEB_HOST_PATH
        ]);
        $api = new IcingaApi();
        $graph = $cache->remember($cacheKey, intdiv($refresh, 2), function () use ($api, $group, $ICINGAWEB_HOST_PATH) {
            return GraphSource::fetch(
                function ($endpoint, $body) use ($api) {
                    $results = $api->sendCommand('GET', $endpoint, $body);
                    if (! is_array($results)) {
                        throw new \Exception("Failed to fetch or decode data from the Icinga2 API.");
                    }
                    return $results;
                },
                $group,
                $ICINGAWEB_HOST_PATH,
                function (\Exception $e) {
                    Logger::warning('topologygraph: could not fetch services: %s', $e->getMessage());
                }
            );
        });

        $graph['hostgroup'] = $group;
        $graph['refresh'] = $refresh;
        $this->_helper->json($graph);
    }


}

