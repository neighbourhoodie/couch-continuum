#!/usr/bin/env node
'use strict'

const readline = require('readline')

const CouchContinuum = require('.')
const log = require('./lib/log')

/*
HELPERS
 */

function getContinuum ({
  copyName,
  couchUrl,
  dbName,
  filterTombstones,
  interval,
  n,
  placement,
  q,
  verbose
}) {
  if (verbose) process.env.LOG = true
  return new CouchContinuum({
    copyName,
    couchUrl,
    dbName,
    filterTombstones,
    interval,
    n,
    placement,
    q
  })
}

async function getConsent (question) {
  question = question || 'Ready to replace the primary with the replica. Continue? [y/N] '
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      const consent = answer.match(/^y$/i)
      return resolve(consent)
    })
  })
}

function catchError (error) {
  console.log('ERROR')
  if (error.error === 'not_found') {
    console.log('Primary database does not exist. There is nothing to migrate.')
  } else if (error.error === 'unauthorized') {
    console.log('Could not authenticate with CouchDB. Are the credentials correct?')
  } else if (error.code === 'EACCES') {
    console.log('Could not access the checkpoint document. Are you running as a different user?')
  } else {
    console.log('Unexpected error: %j', error)
  }
  process.exit(1)
}

/*
MAIN
 */

require('yargs')
  .command({
    command: 'start',
    aliases: ['$0'],
    description: 'Migrate a database to new settings.',
    builder: function (yargs) {
      yargs.options({
        dbName: {
          alias: 'N',
          description: 'The name of the database to modify.',
          required: true,
          type: 'string'
        },
        copyName: {
          alias: 'c',
          description: 'The name of the database to use as a replica. Defaults to {dbName}_temp_copy',
          type: 'string'
        }
      })
    },
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Migrating database '${argv.dbName}'...`)
      try {
        await continuum.createReplica()
        const consent = await getConsent()
        if (!consent) return log('Could not acquire consent. Exiting...')
        await continuum.replacePrimary()
        console.log(`Migrated database: ${argv.dbName}.`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'create-replica',
    aliases: ['create', 'replica'],
    description: 'Create a replica of the given primary.',
    builder: function (yargs) {
      yargs.options({
        dbName: {
          alias: 'n',
          description: 'The name of the database to modify.',
          required: true,
          type: 'string'
        },
        copyName: {
          alias: 'c',
          description: 'The name of the database to use as a replica. Defaults to {dbName}_temp_copy',
          type: 'string'
        }
      })
    },
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Creating replica of ${continuum.db1} at ${continuum.db2}`)
      try {
        await continuum.createReplica()
        console.log(`Created replica of ${continuum.db1}.`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'replace-primary',
    aliases: ['replace', 'primary'],
    description: 'Replace the given primary with the indicated replica.',
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Replacing primary ${continuum.db1} with ${continuum.db2}...`)
      try {
        const consent = await getConsent()
        if (!consent) return log('Could not acquire consent. Exiting...')
        await continuum.replacePrimary()
        console.log(`Successfully replaced ${continuum.db1}`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'migrate-all',
    aliases: ['all'],
    description: 'Migrate all non-special databases to new settings.',
    handler: async function ({
      couchUrl,
      filterTombstones,
      interval,
      placement,
      q,
      verbose
    }) {
      if (verbose) { process.env.LOG = true }
      try {
        const dbNames = await CouchContinuum.getRemaining(couchUrl)
        const continuums = dbNames.map((dbName) => {
          return new CouchContinuum({
            couchUrl,
            dbName,
            filterTombstones,
            interval,
            placement,
            q
          })
        })
        log('Creating replicas...')
        await CouchContinuum.createReplicas(continuums)
        const consent = await getConsent('Ready to replace primaries with replicas. Continue? [y/N] ')
        if (!consent) return console.log('Could not acquire consent. Exiting...')
        log('Replacing primaries...')
        await CouchContinuum.replacePrimaries(continuums)
        await CouchContinuum.removeCheckpoint()
        console.log(`Successfully migrated ${dbNames.join(', ')}.`)
      } catch (error) { catchError(error) }
    }
  })
  .options({
    couchUrl: {
      alias: 'u',
      description: 'The URL of the CouchDB cluster to act upon.',
      default: process.env.COUCH_URL || 'http://localhost:5984'
    },
    interval: {
      alias: 'i',
      description: 'How often (in milliseconds) to check replication tasks for progress.',
      default: 1000
    },
    q: {
      description: 'The desired "q" value for the new database.',
      type: 'number'
    },
    n: {
      description: 'The desired "n" value for the new database.',
      type: 'number'
    },
    verbose: {
      alias: 'v',
      description: 'Enable verbose logging.',
      type: 'boolean'
    },
    placement: {
      alias: 'p',
      description: 'Placement rule for the affected database(s).',
      type: 'string'
    },
    filterTombstones: {
      alias: 'f',
      description: 'Filter tombstones during replica creation. Does not work with CouchDB 1.x',
      default: false
    }
  })
  .config()
  .alias('h', 'help')
  .parse()
