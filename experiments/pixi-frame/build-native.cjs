// Separate runtime: the regular AwayFL build and comparison page stay intact.
const path = require('node:path');
const fs = require('node:fs');
// This worktree shares the checkout's engine dependencies.
const dependencies = path.resolve(__dirname, '../../../awayfl-player/node_modules');
process.env.NODE_PATH = [dependencies, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require('node:module').Module._initPaths();
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const config = require('../../rspack.config.js')({ prod: true });
const output = path.resolve(root, '../hono-proxy/static/game/gamefiles/pixi-benchmark');
config.entry = { 'native-runtime': './src/PixiMain.ts' };
// PROFILE=1 keeps every function name so DevTools traces attribute time to
// parse, construction, compile and tessellation instead of one-letter names.
// The bundle is larger and a little slower to load; rebuild without it to play.
const profile = process.env.PROFILE === '1';
if (profile) config.optimization = { minimize: false };
config.output = { path: output, filename: '[name].js' };
config.plugins = [];
config.resolve.modules.unshift(dependencies);
rspack(config, (error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    process.exitCode = 1;
    return;
  }
  const hash = require('node:crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(output, 'native-runtime.js'))).digest('hex').slice(0, 12);
  const loader = fs.readFileSync(path.resolve(output, '../loader-awayfl.html'), 'utf8')
    .replace('runtime: "/awayfl/js/Main.js"',
      `runtime: "/game/gamefiles/pixi-benchmark/native-runtime.js?v=${hash}"`);
  fs.writeFileSync(path.join(output, 'loader-native.html'), loader);
  console.log('Built experimental authored-path runtime: ' + hash + (profile ? ' (profiling build, unminified)' : ''));
});
