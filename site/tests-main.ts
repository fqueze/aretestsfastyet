/**
 * The page's entry point: import the controller and start it.
 *
 * This file exists so that `site/tests.ts` does not start the page merely by
 * being imported. `site/crashes-main.ts` records why that matters — a
 * controller that runs at module scope cannot be imported by a test.
 */

import { start } from './tests.ts';

await start();
