# couch-continuum

[![Stability](https://img.shields.io/badge/stability-experimental-orange.svg)](https://nodejs.org/api/documentation.html#documentation_stability_index)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

A tool for migrating CouchDB databases. It is useful for modifying database configuration values that can only be set during database creation. For example:

```bash
$ couch-continuum -q 6 -n DB_NAME -u COUCH_URL
[couch-continuum] Migrating database DB_NAME to { q: 6 }...
[couch-continuum] ...success!
```

You can also use it as a [nodejs](http://nodejs.org/) module:

```javascript
const CouchContinuum = require('couch-continuum')

// the complete URL (including credentials) to the CouchDB cluster
const couchUrl
// the name of the database to migrate
const dbName = '...'
// a number for the database's new quorum setting
const q = 8

CouchContinuum.start({ couchUrl, dbName, q }, function (err) {
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

The process exits successfully once the database has been completely migrated. Faced with any kind of failure, the process will attempt to roll affected databases back to their pre-migration state. If the tool is halted prematurely, it will resume the migration if run again.

While the process works, consider the affected database(s) unavailable: reads and writes during this time may return inconsistent or incorrect information about documents in the database. To signal that the database is unavailable, the process sets `/{db}/_local/in-maintenance` to `{ down: true }` and deletes the document once it exits. Application components that depend on the database should poll for the existence of that document and back off when it exists.

## Installation

Currently, you must install the tool from source using [git](https://git-scm.com/) and [npm](https://www.npmjs.com/):

```bash
git clone https://github.com/neighbourhoodie/couch-continuum.git
cd couch-continuum
npm install
npm link
```

Now you can use the `couch-continuum` command. Run `couch-continuum -h` to see usage information.

## Usage

```bash
couch-continuum

Options:
  --version       Show version number                                  [boolean]
  --config        Path to JSON config file
  --couchUrl, -u  The URL of the CouchDB cluster to act upon.
                                              [default: "http://localhost:5984"]
  --dbName, -n    The name of the database to modify.        [string] [required]
  -q              The desired "q" value for the new database.[number] [required]
  --verbose, -v   Enable verbose logging.                              [boolean]
  -h, --help      Show help                                            [boolean]
```

The verbose output will inform you of each stage of the tool's operations. For example:

```
[couch-continuum] Migrating database 'a' to { q: 2 }...
[couch-continuum] Creating temp db: a_temp_copy
[couch-continuum] Setting primary db as unavailable...
[couch-continuum] Beginning replication of primary to temp...
[couch-continuum] Replicated. Destroying primary...
[couch-continuum] Recreating primary with new settings...
[couch-continuum] Setting primary as unavailable (again)...
[couch-continuum] Beginning replication of temp to primary...
[couch-continuum] Replicated. Destroying temp...
[couch-continuum] Setting primary as available...
[couch-continuum] ...success!
```

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
