#!/usr/bin/env node
'use strict'

const CouchContinuum = require('.')
const readline = require('readline')

const prefix = '[couch-continuum]'
function log () {
  arguments[0] = [prefix, arguments[0]].join(' ')
  console.log.apply(console, arguments)
}

function getConsent () {
  const question = 'Ready to replace the primary with the replica. Continue? [y/N] '
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

require('yargs')
  .command({
    command: 'create-replica',
    aliases: ['create', 'replica'],
    description: 'Create a replica of the given primary.',
    handler: function (argv) {
      const { couchUrl, dbName, copyName, q, verbose } = argv
      if (verbose) process.env.LOG = true
      const options = { couchUrl, dbName, copyName, q }
      const continuum = new CouchContinuum(options)
      log(`Creating replica of ${continuum.db1} at ${continuum.db2}`)
      continuum.createReplica().then(() => {
        log('... success!')
      })
    }
  })
  .command({
    command: 'replace-primary',
    aliases: ['replace', 'primary'],
    description: 'Replace the given primary with the indicated replica. Does not create a replica.',
    handler: function (argv) {
      const { couchUrl, dbName, copyName, q, verbose } = argv
      if (verbose) process.env.LOG = true
      const options = { couchUrl, dbName, copyName, q }
      const continuum = new CouchContinuum(options)
      log(`Replacing primary ${continuum.db1} with ${continuum.db2} and settings { q:${q} }`)
      getConsent().then((consent) => {
        if (!consent) return log('Could not acquire consent. Exiting...')
        return continuum.replacePrimary().then(() => {
          log('... success!')
        })
      })
    }
  })
  .command({
    command: 'start',
    aliases: ['$0'],
    description: 'Create a replica of the given primary and regenerate it with new settings.',
    handler: function (argv) {
      const { couchUrl, dbName, copyName, q, verbose } = argv
      if (verbose) process.env.LOG = true
      const options = { couchUrl, dbName, copyName, q }
      const continuum = new CouchContinuum(options)
      log(`Migrating database '${dbName}' to { q: ${q} }...`)
      continuum.createReplica().then(function () {
        return getConsent()
      }).then((consent) => {
        if (!consent) return log('Could not acquire consent. Exiting...')
        return continuum.replacePrimary().then(() => {
          log('... success!')
        })
      })
    }
  })
  .options({
    couchUrl: {
      alias: 'u',
      description: 'The URL of the CouchDB cluster to act upon.',
      default: process.env.COUCH_URL || 'http://localhost:5984'
    },
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
    },
    q: {
      description: 'The desired "q" value for the new database.',
      required: true,
      type: 'number'
    },
    verbose: {
      alias: 'v',
      description: 'Enable verbose logging.',
      type: 'boolean'
    }
  })
  .config()
  .alias('h', 'help')
  .parse()
