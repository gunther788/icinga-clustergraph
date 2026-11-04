<?php

namespace Icinga\Module\Topologygraph\Controllers;

use Icinga\Application\Config;
use Icinga\Module\Topologygraph\Forms\ModuleconfigForm;
use Icinga\Web\Controller;

class ConfigController extends Controller
{
    /**
     * General configuration for Topologygraph
     */


    public function indexAction()
    {
        $form = (new ModuleconfigForm())
            ->setIniConfig(Config::module('topologygraph', "config"));

        $form->handleRequest();

        $this->view->tabs = $this->Module()->getConfigTabs()->activate('config');

        $this->view->form = $form;
    }


}

