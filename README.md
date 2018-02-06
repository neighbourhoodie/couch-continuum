# couch-continuum

[![Stability](https://img.shields.io/badge/stability-experimental-orange.svg)](https://nodejs.org/api/documentation.html#documentation_stability_index)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

A tool for migrating CouchDB databases. It is useful for modifying database configuration values that can only be set during database creation. For example:

```bash
$ COUCH_URL=https://... couch-continuum -q 6 <DB_NAME>
Migrating DB_NAME...
...success!
Differences:
- q: 8
+ q: 6
```

You can also use it as a [nodejs](http://nodejs.org/) module:

```javascript
const CouchContinuum = require('couch-continuum')
const OPTIONS = { ... }

CouchContinuum.start(OPTIONS, function (err) {
	// Reports an error if any occurred.
	// Otherwise, the DB was successfully migrated!
})
```

## Why?

Some database settings can only be set when the database is created. In order to modify these values, it is necessary to create a new database and migrate the data from the old database to the new one. CouchContinuum handles this migration process for you so that it works reliably, and so your application can work around the migration while the database is unavailable.

## How it works

**NOTE: CouchContinuum's approach involves some downtime where the database being migrated is unavailable. Use accordingly!**

CouchContinuum works like this:

1. Given a database A1, creates database A2 with desired settings.
2. Replicates A1 to A2.
3. Delete A1
4. Create A1 with desired settings.
5. Replicate A2 to A1.

The process exits successfully once the database has been completely migrated. Faced with any kind of failure, the process will attempt to roll affected databases back to their pre-migration state.

While the process works, consider the affected database(s) unavailable: reads and writes during this time may return inconsistent or incorrect information about documents in the database. To signal that the database is unavailable, the process sets `/{db}/_local/in-maintenance` to `{ down: true }` and deletes the document once it exits.

## Installation

TODO

## Usage

TODO

## Why "Continuum"?

Modifying "q" values reminds me of [Q from Star Trek](https://en.wikipedia.org/wiki/Q_%28Star_Trek%29) and their "Q Continuum".

## Development

Download the project's source in order to run the test suite:

```bash
git clone https://github.com/neighbourhoodie/couch-continuum.git
cd couch-continuum
npm install
npm test
```

## Contributions

All contributions are welcome: bug reports, feature requests, "why doesn't this work" questions, patches for fixes and features, etc. For all of the above, [file an issue](https://github.com/garbados/mastermind-game/issues) or [submit a pull request](https://github.com/garbados/mastermind-game/pulls).

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
