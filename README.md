# couch-continuum

[![Stability](https://img.shields.io/badge/stability-stable-green.svg?style=flat-square)](https://nodejs.org/api/documentation.html#documentation_stability_index)
[![npm version](https://img.shields.io/npm/v/couch-continuum.svg?style=flat-square)](https://www.npmjs.com/package/couch-continuum)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg?style=flat-square)](https://standardjs.com)

A tool for migrating CouchDB databases. It is useful for modifying database configuration values that can only be set during database creation, like `q` and `placement`. For example:

```bash
$ couch-continuum -N hello-world -q 4 -n 1 -u http://$USER:$PASS@localhost:5984
[couch-continuum] Migrating database 'hello-world'...
Ready to replace the primary with the replica. Continue? [y/N] y
[couch-continuum] Recreating primary hello-world
[couch-continuum] (====================) 100% 0.0s
[couch-continuum] ... success!
```

## Why?

Some database settings can only be set when the database is created, like `q` and `placement`. `q` reflects the number of shards to maintain per replica of a database, and `placement` indicates where those shards will be stored.

In order to modify these values, it is necessary to create a new database and migrate the data from the old database to the new one. CouchContinuum handles this migration process for you so that it works reliably, and so your application can work around the migration while the database is unavailable.

Additionally, databases can accumulate [tombstones of deleted documents](http://docs.couchdb.org/en/latest/api/document/common.html#delete--db-docid) that can slow down certain activities. CouchContinuum optionally filters out these tombstones when it migrates a database.

## How it works

**NOTE: CouchContinuum's approach involves some downtime where the database being migrated is unavailable. Use accordingly!**

CouchContinuum works in two parts:

1. Create a replica of a given database (aka "the primary"):
    1. Verify that the primary is not in use.
    2. Create the replica database.
    3. Replicate the primary to the replica.
    4. Verify that the primary was not updated during replication.
    5. Verify that the primary and replica match.
    6. Replica is now complete and verified.
2. Replace the primary with a replica:
    1. Verify that the primary is not in use.
    2. Verify that the primary and the replica match.
    3. Destroy the primary, leaving it unavailable until step 7.
    4. Re-create the primary with new settings.
    5. Set the primary as unavailable.
    6. Replicate the replica to the primary.
    7. Set the primary as available again.
    8. Primary has now successfully migrated to new settings.

The process exits successfully once the database has been completely migrated. The first part of migration -- creating a replica -- is not destructive, while the second part is. As such, the program asks the user to explicitly consent to replacing the primary.

During the migration process, consider the affected database(s) unavailable: reads during this time may return inconsistent or incorrect information about documents in the database. If the program detects that the primary is still receiving updates, it will exit with an error. **Ensure nobody is using a database before migrating it!**

While the database is being migrated, it will either not exist, or have a local document accessible at `/{dbName}/_local/in-maintenance` that contains the body `{ down: true }`. Application components that rely on the database should detect either of these states and back off accordingly.

## Installation

Install the tool using [npm](https://www.npmjs.com/):

```bash
$ npm install -g couch-continuum
```

Now you can use the `couch-continuum` command. Run `couch-continuum -h` to see usage information.

## Usage

```
$ couch-continuum -h

couch-continuum

Migrate a database to new settings.

Commands:
  couch-continuum start            Migrate a database to new settings. [default]
  couch-continuum create-replica   Create a replica of the given primary.
                                                      [aliases: create, replica]
  couch-continuum replace-primary  Replace the given primary with the indicated
                                   replica.          [aliases: replace, primary]
  couch-continuum migrate-all      Migrate all non-special databases to new
                                   settings.                      [aliases: all]

Options:
  --version                     Show version number                    [boolean]
  --source, --dbNames, -N, -s   The name or URL of a database to use as a
                                primary.                     [string] [required]
  --target, --copyName, -c, -t  The name or URL of a database to use as a
                                replica. Defaults to {source}_temp_copy [string]
  --couchUrl, -u                The URL of the CouchDB cluster to act upon.
                               [default: "http://admin:password@localhost:5984"]
  --interval, -i                How often (in milliseconds) to check replication
                                tasks for progress.              [default: 1000]
  -q                            The desired "q" value for the new database.
                                                                        [number]
  -n                            The desired "n" value for the new database.
                                                                        [number]
  --verbose, -v                 Enable verbose logging.                [boolean]
  --placement, -p               Placement rule for the affected database(s).
                                                                        [string]
  --filterTombstones, -f        Filter tombstones during replica creation. Does
                                not work with CouchDB 1.x       [default: false]
  --replicateSecurity, -r       Replicate a database's /_security object in
                                addition to its documents.      [default: false]
  --allowReplications           Allow ongoing replications to the source
                                database                        [default: false]
  --continuous                  Create a continuous replication from source to
                                replica                         [default: false]
  --config                      Path to JSON config file
  -h, --help                    Show help                              [boolean]
```

The verbose output will inform you of each stage of the tool's operations. For example:

```
$ couch-continuum -s hello-world -q 4 -u https://... -v
[couch-continuum] Created new continuum: {
  "url": "localhost:5984",
  "source": "localhost:5984/hello-world",
  "target": "localhost:5984/hello-world_temp_copy",
  "interval": 1000,
  "q": 4
}
[couch-continuum] Migrating database: localhost:5984/hello-world
[couch-continuum] Creating replica localhost:5984/hello-world_temp_copy...
[couch-continuum] [0/5] Checking if primary is in use...
[couch-continuum] [1/5] Creating replica db: localhost:5984/hello-world_temp_copy
[couch-continuum] [2/5] Beginning replication of primary to replica...
[couch-continuum] [3/5] Verifying primary did not change during replication...
[couch-continuum] [4/5] Verifying primary and replica match...
[couch-continuum] [5/5] Primary copied to replica.
Ready to replace the primary with the replica. Continue? [y/N] y
[couch-continuum] Replacing primary localhost:5984/hello-world using localhost:5984/hello-world_temp_copy...
[couch-continuum] [0/8] Checking if primary is in use...
[couch-continuum] [1/8] Verifying primary and replica match...
[couch-continuum] [2/8] Destroying primary...
[couch-continuum] [3/8] Recreating primary with new settings...
[couch-continuum] Recreating primary localhost:5984/hello-world
[couch-continuum] (====================) 100% 0.0s
[couch-continuum] [4/8] Setting primary to unavailable.
[couch-continuum] [5/8] Beginning replication of replica to primary...
[couch-continuum] [6/8] Replicated. Destroying replica...
[couch-continuum] [7/8] Setting primary to available.
[couch-continuum] [8/8] Primary migrated to new settings.
Migrated database: localhost:5984/hello-world
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

All contributions are welcome: bug reports, feature requests, "why doesn't this work" questions, patches for fixes and features, etc. For all of the above, [file an issue](https://github.com/neighbourhoodie/couch-continuum/issues) or [submit a pull request](https://github.com/neighbourhoodie/couch-continuum/pulls).

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)

(c) 2018–2022 Neighbourhoodie Software & Open Source contributors
