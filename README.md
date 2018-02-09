# couch-continuum

[![Stability](https://img.shields.io/badge/stability-experimental-orange.svg)](https://nodejs.org/api/documentation.html#documentation_stability_index)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

A tool for migrating CouchDB databases. It is useful for modifying database configuration values that can only be set during database creation. For example:

```bash
$ COUCH_URL=http://$USER:$PASS@localhost:5984 couch-continuum -n test-database -q 4
[couch-continuum] Migrating database 'test-database' to { q: 4 }...
Ready to replace the primary with the replica. Continue? [y/N] y
[couch-continuum] ... success!
```

## Why?

Some database settings can only be set when the database is created. In order to modify these values, it is necessary to create a new database and migrate the data from the old database to the new one. CouchContinuum handles this migration process for you so that it works reliably, and so your application can work around the migration while the database is unavailable.

## How it works

**NOTE: CouchContinuum's approach involves some downtime where the database being migrated is unavailable. Use accordingly!**

CouchContinuum works in two parts:

1. Create a replica of a given database (aka "the primary"):
    1. Verify that the primary is not in use.
    2. Replicate the primary to the replica.
    3. Verify that the primary was not updated during replication.
    4. Replica is now complete and verified.
2. Replace the primary with a replica:
    1. Verify that the primary is not in use.
    2. Destroy the primary and re-create it with new settings.
    3. Replicate the replica to the primary.
    4. Primary has now successfully migrated to new settings.

The process exits successfully once the database has been completely migrated. The first part of migration -- creating a replica -- is not destructive, while the second part is. As such, the program asks the user to explicitly consent to replacing the primary.

While the process works, consider the affected database(s) unavailable: reads during this time may return inconsistent or incorrect information about documents in the database. If the program detects that the primary is still receiving updates, it will exit with an error. **Ensure nobody is using a database before migrating it!**

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

```
$ couch-continuum -h

couch-continuum

Migrate a database to new settings.

Commands:
  couch-continuum start            Migrate a database to new settings. [default]
  couch-continuum create-replica   Create a replica of the given primary. (step
                                   one)               [aliases: create, replica]
  couch-continuum replace-primary  Replace the given primary with the indicated
                                   replica. (step two)
                                                     [aliases: replace, primary]

Options:
  --version       Show version number                                  [boolean]
  --couchUrl, -u  The URL of the CouchDB cluster to act upon.
                                              [default: "http://localhost:5984"]
  --dbName, -n    The name of the database to modify.        [string] [required]
  --copyName, -c  The name of the database to use as a replica. Defaults to
                  {dbName}_temp_copy                                    [string]
  -q              The desired "q" value for the new database.[number] [required]
  --verbose, -v   Enable verbose logging.                              [boolean]
  --config        Path to JSON config file
  -h, --help      Show help                                            [boolean]
```

The verbose output will inform you of each stage of the tool's operations. For example:

```
$ couch-continuum -n a -q 4 -u http://...
[couch-continuum] Migrating database 'a' to { q: 4 }...
[couch-continuum] Creating replica a_temp_copy...
[couch-continuum] [0/5] Checking if primary is in use...
[couch-continuum] [1/5] Creating temp db: a_temp_copy
[couch-continuum] [2/5] Beginning replication of primary to temp...
[couch-continuum] [3/5] Verifying primary did not change during replication...
[couch-continuum] [4/5] Verifying primary and replica match...
[couch-continuum] [5/5] Primary copied to replica.
Ready to replace the primary with the replica. Continue? [y/N] y
[couch-continuum] Replacing primary a...
[couch-continuum] [0/6] Checking if primary is in use...
[couch-continuum] [1/6] Verifying primary and replica match...
[couch-continuum] [2/6] Destroying primary...
[couch-continuum] [3/6] Recreating primary with new settings...
[couch-continuum] [4/6] Beginning replication of temp to primary...
[couch-continuum] [5/6] Replicated. Destroying temp...
[couch-continuum] [6/6] Primary migrated to new settings.
[couch-continuum] ... success!
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
