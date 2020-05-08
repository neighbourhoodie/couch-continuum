#!/usr/bin/env node
'use strict'

const assert = require('assert').strict
const readline = require('readline')

const CouchContinuum = require('.')
const log = require('./lib/log')

/*
HELPERS
 */

function getContinuum ({
  couchUrl,
  filterTombstones,
  interval,
  n,
  placement,
  q,
  replicateSecurity,
  source,
  target,
  verbose
}) {
  if (verbose) process.env.LOG = true
  return new CouchContinuum({
    couchUrl,
    filterTombstones,
    interval,
    n,
    placement,
    q,
    replicateSecurity,
    source,
    target
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
    assert.fail(`Unexpected error: ${JSON.stringify(error)}`)
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
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Migrating database: ${continuum.source.host}${continuum.source.path}`)
      try {
        await continuum.createReplica()
        const consent = await getConsent()
        if (!consent) return log('Could not acquire consent. Exiting...')
        await continuum.replacePrimary()
        console.log(`Migrated database: ${continuum.source.host}${continuum.source.path}`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'create-replica',
    aliases: ['create', 'replica'],
    description: 'Create a replica of the given primary.',
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Creating replica of ${continuum.source.host}${continuum.source.path} at ${continuum.target.host}${continuum.target.path}`)
      try {
        await continuum.createReplica()
        console.log(`Created replica of ${continuum.source.host}${continuum.source.path}`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'replace-primary',
    aliases: ['replace', 'primary'],
    description: 'Replace the given primary with the indicated replica.',
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Replacing primary ${continuum.source.host}${continuum.source.path} with ${continuum.target.host}${continuum.target.path}`)
      try {
        const consent = await getConsent()
        if (!consent) return log('Could not acquire consent. Exiting...')
        await continuum.replacePrimary()
        console.log(`Successfully replaced ${continuum.source.host}${continuum.source.path}`)
      } catch (error) { catchError(error) }
    }
  })
  .command({
    command: 'migrate-all',
    aliases: ['all'],
    description: 'Migrate all non-special databases to new settings.',
    handler: async function (argv) {
      const { couchUrl, verbose } = argv
      if (verbose) { process.env.LOG = true }
      try {
        const dbNames = await CouchContinuum.getRemaining(couchUrl)
        const continuums = dbNames.map((dbName) => {
          return new CouchContinuum({ dbName, ...argv })
        })
        log('Creating replicas...')
        await CouchContinuum.createReplicas(continuums)
        const consent = await getConsent('Ready to replace primaries with replicas. Continue? [y/N] ')
        if (!consent) return console.log('Could not acquire consent. Exiting...')
        log('Replacing primaries...')
        await CouchContinuum.replacePrimaries(continuums)
        await CouchContinuum.removeCheckpoint()
        console.log(`Successfully migrated databases: ${dbNames.join(', ')}`)
      } catch (error) { catchError(error) }
    }
  })
  // backwards compat with old flag names
  .alias('source', 'dbNames')
  .alias('source', 'N')
  .alias('target', 'copyName')
  .alias('target', 'c')
  // actual options
  .options({
    source: {
      alias: 's',
      description: 'The name or URL of a database to use as a primary.',
      required: true,
      type: 'string'
    },
    target: {
      alias: 't',
      description: 'The name or URL of a database to use as a replica. Defaults to {source}_temp_copy',
      type: 'string'
    },
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
    },
    replicateSecurity: {
      alias: 'r',
      description: 'Replicate a database\'s /_security object in addition to its documents.',
      default: true
    }
  })
  .config()
  .alias('h', 'help')
  .parse()
