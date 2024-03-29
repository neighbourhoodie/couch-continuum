#!/usr/bin/env node
'use strict'

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
  verbose,
  allowReplications,
  continuous
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
    target,
    allowReplications,
    continuous
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

function generalOptions (yargs) {
  return yargs
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
      },
      allowReplications: {
        description: 'Allow ongoing replications to the source database.',
        default: false,
        type: 'boolean'
      },
      continuous: {
        description: 'Create a continuous replication from source to replica',
        default: false,
        type: 'boolean'
      }
    })
}

/*
MAIN
 */

require('yargs')
  .command({
    command: 'start',
    aliases: ['$0'],
    description: 'Migrate a database to new settings.',
    builder: generalOptions,
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Migrating database: ${continuum.source.host}${continuum.source.pathname}`)
      await continuum.createReplica()
      const consent1 = await getConsent()
      if (!consent1) return log('Could not acquire consent. Exiting...')
      await continuum.replacePrimary()
      console.log(`Migrated database: ${continuum.source.host}${continuum.source.pathname}`)
      log(`Migrating database: ${continuum.source.host}${continuum.source.pathname}`)
      await continuum.createReplica()
      const consent2 = await getConsent()
      if (!consent2) return log('Could not acquire consent. Exiting...')
      await continuum.replacePrimary()
      console.log(`Migrated database: ${continuum.source.host}${continuum.source.pathname}`)
    }
  })
  .command({
    command: 'create-replica',
    aliases: ['create', 'replica'],
    description: 'Create a replica of the given primary.',
    builder: generalOptions,
    handler: async function (argv) {
      const continuum = getContinuum({ ...argv, allowReplications: true })
      log(`Creating replica of ${continuum.source.host}${continuum.source.pathname} at ${continuum.target.host}${continuum.target.pathname}`)
      await continuum.createReplica()
      console.log(`Created replica of ${continuum.source.host}${continuum.source.pathname}`)
      log(`Creating replica of ${continuum.source.host}${continuum.source.pathname} at ${continuum.target.host}${continuum.target.pathname}`)
      await continuum.createReplica()
      console.log(`Created replica of ${continuum.source.host}${continuum.source.pathname}`)
    }
  })
  .command({
    command: 'replace-primary',
    aliases: ['replace', 'primary'],
    description: 'Replace the given primary with the indicated replica.',
    builder: generalOptions,
    handler: async function (argv) {
      const continuum = getContinuum(argv)
      log(`Replacing primary ${continuum.source.host}${continuum.source.pathname} with ${continuum.target.host}${continuum.target.pathname}`)
      const consent = await getConsent()
      if (!consent) return log('Could not acquire consent. Exiting...')
      await continuum.replacePrimary()
      console.log(`Successfully replaced ${continuum.source.host}${continuum.source.pathname}`)
    }
  })
  .command({
    command: 'migrate-all',
    aliases: ['all'],
    description: 'Migrate all non-special databases to new settings.',
    builder: function (yargs) {
      yargs.options({
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
        },
        allowReplications: {
          description: 'Allow ongoing replications to the source database.',
          default: false,
          type: 'boolean'
        },
        continuous: {
          description: 'Create a continuous replication from source to replica',
          default: false,
          type: 'boolean'
        }
      })
    },
    handler: async function (argv) {
      const { couchUrl, verbose } = argv
      if (verbose) { process.env.LOG = true }
      const dbNames = await CouchContinuum.getRemaining(couchUrl)
      if (!dbNames.length) {
        console.log('No eligible databases to migrate.')
        return
      }
      const continuums = dbNames.map((source) => {
        return new CouchContinuum({ source, ...argv })
      })
      log('Creating replicas...')
      await CouchContinuum.createReplicas(continuums)
      const consent = await getConsent('Ready to replace primaries with replicas. Continue? [y/N] ')
      if (!consent) return console.log('Could not acquire consent. Exiting...')
      log('Replacing primaries...')
      await CouchContinuum.replacePrimaries(continuums)
      await CouchContinuum.removeCheckpoint()
      console.log(`Successfully migrated databases: ${dbNames.join(', ')}`)
    }
  })
  .config()
  .alias('h', 'help')
  .fail((msg, error, yargs) => {
    if (!error) {
      console.log(msg)
    } else if (error.error === 'not_found') {
      console.log('Primary database does not exist. There is nothing to migrate.')
    } else if (error.error === 'unauthorized') {
      console.log('Could not authenticate with CouchDB. Are the credentials correct?')
    } else if (error.code === 'EACCES') {
      console.log('Could not access the checkpoint document. Are you running as a different user?')
    } else {
      console.log('Unexpected error. Please report this so we can fix it!')
      console.log(error)
    }
    process.exit(1)
  })
  .parse()
