#!/usr/bin/env node
'use strict'

const CouchContinuum = require('.')
const fs = require('fs')
const readline = require('readline')

/*
HELPERS
 */

const prefix = '[couch-continuum]'
function log () {
  arguments[0] = [prefix, arguments[0]].join(' ')
  console.log.apply(console, arguments)
}

function getContinuum (argv) {
  const { couchUrl, dbName, copyName, interval, q, verbose } = argv
  if (verbose) process.env.LOG = true
  const options = { couchUrl, dbName, copyName, interval, q }
  return new CouchContinuum(options)
}

function getConsent (question) {
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
  log('ERROR')
  if (error.error) {
    if (error.error === 'not_found') {
      log('Primary database does not exist. There is nothing to migrate.')
    } else if (error.error === 'unauthorized') {
      log('Could not authenticate with CouchDB. Are the credentials correct?')
    }
  } else {
    log('Unexpected error: %j', error)
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
    handler: function (argv) {
      const continuum = getContinuum(argv)
      log(`Migrating database '${argv.dbName}' to new settings { q: ${argv.q} }...`)
      continuum.createReplica().then(function () {
        return getConsent()
      }).then((consent) => {
        if (!consent) return log('Could not acquire consent. Exiting...')
        return continuum.replacePrimary().then(() => {
          log('... success!')
        })
      }).catch(catchError)
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
    handler: function (argv) {
      const continuum = getContinuum(argv)
      log(`Creating replica of ${continuum.db1} at ${continuum.db2}`)
      continuum.createReplica().then(() => {
        log('... success!')
      }).catch(catchError)
    }
  })
  .command({
    command: 'replace-primary',
    aliases: ['replace', 'primary'],
    description: 'Replace the given primary with the indicated replica.',
    handler: function (argv) {
      const continuum = getContinuum(argv)
      log(`Replacing primary ${continuum.db1} with ${continuum.db2} and settings { q:${continuum.q} }`)
      getConsent().then((consent) => {
        if (!consent) return log('Could not acquire consent. Exiting...')
        return continuum.replacePrimary().then(() => {
          log('... success!')
        })
      }).catch(catchError)
    }
  })
  .command({
    command: 'migrate-all',
    aliases: ['all'],
    description: 'Migrate all non-special databases to new settings.',
    handler: function (argv) {
      const { couchUrl, interval, q, verbose } = argv
      if (verbose) process.env.LOG = true
      CouchContinuum.allDbs(couchUrl).then((dbNames) => {
        // skip already done
        var lastDb = '\u0000'
        try {
          lastDb = fs.readFileSync('.progress', 'utf-8')
        } catch (e) {
          console.log(e.code)
          if (e.code !== 'ENOENT') throw e
        }
        return dbNames.filter((dbName) => {
          return dbName > lastDb
        })
      }).then((dbNames) => {
        // create continuums for each db
        return dbNames.map((dbName) => {
          const options = { couchUrl, dbName, interval, q }
          return new CouchContinuum(options)
        })
      }).then((continuums) => {
        return continuums.map((continuum) => {
          return () => {
            return continuum.createReplica()
          }
        }).reduce((a, b) => {
          return a.then(b)
        }, Promise.resolve()).then(() => {
          return continuums.map((continuum) => {
            return () => {
              return continuum.replacePrimary().then(() => {
                // mark checkpoint
                fs.writeFileSync('.progress', continuum.db1, 'utf-8')
              })
            }
          }).reduce((a, b) => {
            return a.then(b)
          }, Promise.resolve())
        })
      }).then(() => {
        // once all done, remove the progress marker
        fs.unlinkSync('.progress')
      })
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
