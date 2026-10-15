/**
 * Runs the spec files in the order of their names (01-..., 02-...), the same on every machine and in every run.
 * Jest's default order depends on file size and on the timings of the previous run; all files of this suite
 * share one database, so a fixed order is what makes a failure reproducible.
 */
const path = require('node:path');

const api = path.join(__dirname, '..', '..', 'services', 'api');
const resolveFrom = (name, dir) => require.resolve(name, { paths: [dir] });
// @jest/test-sequencer is a dependency of jest (of @jest/core), not of this repository: find it from there.
const jestMain = resolveFrom('jest', api);
const coreMain = resolveFrom('@jest/core', path.dirname(jestMain));
const Sequencer = require(resolveFrom('@jest/test-sequencer', path.dirname(coreMain))).default;

class ByName extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = ByName;
