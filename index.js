'use strict'

const assert = require('assert')
const request = require('request')

const prefix = '[couch-continuum]'
function log () {
  if (process.env.DEBUG || process.env.LOG) {
    arguments[0] = [prefix, arguments[0]].join(' ')
    console.log.apply(console, arguments)
  }
}

function makeCallBack (resolve, reject) {
  return (err, res, body) => {
    if (typeof body === 'string') body = JSON.parse(body)
    if (err || body.error) return reject(err || body)
    else return resolve()
  }
}

module.exports =
class CouchContinuum {
  constructor ({ couchUrl, dbName, copyName, q }) {
    assert(couchUrl, 'The Continuum requires a URL for accessing CouchDB.')
    assert(dbName, 'The Continuum requires a target database.')
    assert(q, 'The Continuum requires a desired "q" setting.')
    this.url = couchUrl
    this.db1 = dbName
    this.db2 = copyName || (this.db1 + '_temp_copy')
    this.q = q
  }

  _createDb (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'PUT',
        json: { q: this.q }
      }, done)
    })
  }

  _destroyDb (dbName) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, dbName].join('/')
      request({
        url,
        method: 'DELETE'
      }, done)
    })
  }

  _replicate (source, target) {
    return new Promise((resolve, reject) => {
      const done = makeCallBack(resolve, reject)
      const url = [this.url, '_replicate'].join('/')
      request({
        url,
        method: 'POST',
        json: { source, target }
      }, done)
    })
  }

  /**
   * Retrieve the update sequence for a given database.
   * @param  {String} dbName  Name of the database to check.
   * @return {Promise}        Resolves with the database's update sequence.
   */
  _getUpdateSeq (dbName) {
    return new Promise((resolve, reject) => {
      request({
        url: [this.url, dbName].join('/'),
        json: true
      }, (err, res, body) => {
        if (err || body.error) return reject(err || body)
        const { update_seq } = body
        return resolve(update_seq)
      })
    })
  }

  /**
   * Check if a database is still receiving updates or is
   * otherwise being monitored.
   * @param  {String}  dbName     Name of the database to check.
   * @return {Promise<Boolean>}   Whether the database is in use.
   */
  _isInUse (dbName) {
    // collect /_active_tasks
    return new Promise((resolve, reject) => {
      request({
        url: [this.url, '_active_tasks'].join('/'),
        json: true
      }, (err, res, body) => {
        if (err || body.error) return reject(err || body)
        return resolve(body)
      })
    }).then((activeTasks) => {
      // collect /_schedular/jobs
      return new Promise((resolve, reject) => {
        request({
          url: [this.url, '_scheduler', 'jobs'].join('/'),
          json: true
        }, (err, res, body) => {
          if (err || body.error) return reject(err || body)
          const { jobs } = body
          return resolve(jobs)
        })
      }).then((jobs) => {
        // verify that the given dbName is not involved
        jobs.concat(activeTasks).forEach(({ database }) => {
          assert.notEqual(database, dbName, `${dbName} is still in use.`)
        })
      })
    })
  }

  /**
   * Create a replica for the migration.
   * @return {Promise} Promise that resolves once
   *                   the replica has been created
   */
  createReplica () {
    let lastSeq1, lastSeq2
    log(`Creating replica ${this.db2}...`)
    log('[0/4] Checking if primary is in use...')
    return this._isInUse(this.db1).then(() => {
      return this._getUpdateSeq(this.db1).then((seq) => {
        lastSeq1 = seq
      })
    }).then(() => {
      log('[1/4] Creating temp db:', this.db2)
      return this._createDb(this.db2).catch((err) => {
        const exists = (err.error && err.error === 'file_exists')
        if (exists) return true
        else throw err
      })
    }).then(() => {
      log('[2/4] Beginning replication of primary to temp...')
      return this._replicate(this.db1, this.db2)
    }).then(() => {
      log('[3/4] Replicated. Verifying replica...')
      return this._getUpdateSeq(this.db1).then((seq) => {
        lastSeq2 = seq
        assert.equal(lastSeq1, lastSeq2, `${this.db1} is still receiving updates. Exiting...`)
      })
    }).then(() => {
      log('[4/4] Primary copied to replica.')
    })
  }

  replacePrimary () {
    log(`Replacing primary ${this.db1}...`)
    log('[0/5] Checking if primary is in use...')
    return this._isInUse(this.db1).then(() => {
      log('[1/5] Destroying primary...')
      return this._destroyDb(this.db1)
    }).then(() => {
      log('[2/5] Recreating primary with new settings...')
      return this._createDb(this.db1)
    }).then(() => {
      log('[3/5] Beginning replication of temp to primary...')
      return this._replicate(this.db2, this.db1)
    }).then(() => {
      log('[4/5] Replicated. Destroying temp...')
      return this._destroyDb(this.db2)
    }).then(() => {
      log('[5/5] Primary migrated to new settings.')
    })
  }
}
