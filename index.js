'use strict'

const assert = require('assert')
const ProgressBar = require('progress')
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
    else return resolve(body)
  }
}

function makeRequest (options) {
  return new Promise((resolve, reject) => {
    const done = makeCallBack(resolve, reject)
    request(options, done)
  })
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
    return makeRequest({
      url: [this.url, dbName].join('/'),
      method: 'PUT',
      json: { q: this.q }
    })
  }

  _destroyDb (dbName) {
    return makeRequest({
      url: [this.url, dbName].join('/'),
      method: 'DELETE',
      json: true
    })
  }

  _replicate (source, target) {
    return makeRequest({
      url: [this.url, source].join('/'),
      json: true
    }).then((body) => {
      const total = body.doc_count
      const text = '[couch-continuum] Replicating (:bar) :percent :etas'
      const bar = new ProgressBar(text, {
        incomplete: ' ',
        width: 20,
        total
      })
      var current = 0
      const timer = setInterval(() => {
        makeRequest({
          url: [this.url, target].join('/'),
          json: true
        }).then((body) => {
          const latest = body.doc_count
          const delta = latest - current
          bar.tick(delta)
          current = latest
          if (bar.complete) clearInterval(timer)
        })
      }, 1000)
      return makeRequest({
        url: [this.url, '_replicate'].join('/'),
        method: 'POST',
        json: { source, target }
      }).then(() => {
        bar.tick(total)
        clearInterval(timer)
      })
    })
  }

  _verifyReplica () {
    const getDocCount = (dbName) => {
      return makeRequest({
        url: [this.url, dbName].join('/'),
        json: true
      }).then((body) => {
        return body.doc_count
      })
    }

    return Promise.all([
      getDocCount(this.db1),
      getDocCount(this.db2)
    ]).then(([docCount1, docCount2]) => {
      assert.equal(docCount1, docCount2, 'Primary and replica do not have the same number of documents.')
    })
  }

  _setUnavailable () {
    return makeRequest({
      url: [this.url, this.db1, '_local', 'in-maintenance'].join('/'),
      method: 'PUT',
      json: { down: true }
    }).catch((error) => {
      if (error.error === 'file_exists') return null
      else throw error
    })
  }

  _setAvailable () {
    const url = [this.url, this.db1, '_local', 'in-maintenance'].join('/')
    return makeRequest({ url, json: true }).catch((error) => {
      if (error.error === 'not_found') return {}
      else throw error
    }).then(({ _rev }) => {
      const qs = _rev ? { rev: _rev } : {}
      return makeRequest({ url, qs, method: 'DELETE' })
    })
  }

  /**
   * Retrieve the update sequence for a given database.
   * @param  {String} dbName  Name of the database to check.
   * @return {Promise}        Resolves with the database's update sequence.
   */
  _getUpdateSeq (dbName) {
    return makeRequest({
      url: [this.url, dbName].join('/'),
      json: true
    }).then((body) => {
      return body.update_seq
    })
  }

  /**
   * Check if a database is still receiving updates or is
   * otherwise being monitored.
   * @param  {String}  dbName     Name of the database to check.
   * @return {Promise<Boolean>}   Whether the database is in use.
   */
  _isInUse (dbName) {
    return Promise.all([
      makeRequest({
        url: [this.url, '_active_tasks'].join('/'),
        json: true
      }),
      makeRequest({
        url: [this.url, '_scheduler', 'jobs'].join('/'),
        json: true
      })
    ]).then(([activeTasks, jobsResponse]) => {
      const { jobs } = jobsResponse
      // verify that the given dbName is not involved
      // in any active jobs or tasks
      jobs.concat(activeTasks).forEach(({ database }) => {
        assert.notEqual(database, dbName, `${dbName} is still in use.`)
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
    log('[0/5] Checking if primary is in use...')
    return this._isInUse(this.db1).then(() => {
      return this._getUpdateSeq(this.db1).then((seq) => {
        lastSeq1 = seq
      })
    }).then(() => {
      log('[1/5] Creating replica db:', this.db2)
      return this._createDb(this.db2).catch((err) => {
        const exists = (err.error && err.error === 'file_exists')
        if (exists) return true
        else throw err
      })
    }).then(() => {
      log('[2/5] Beginning replication of primary to replica...')
      return this._replicate(this.db1, this.db2)
    }).then(() => {
      log('[3/5] Verifying primary did not change during replication...')
      return this._getUpdateSeq(this.db1).then((seq) => {
        lastSeq2 = seq
        assert.equal(lastSeq1, lastSeq2, `${this.db1} is still receiving updates. Exiting...`)
      })
    }).then(() => {
      log('[4/5] Verifying primary and replica match...')
      return this._verifyReplica()
    }).then(() => {
      log('[5/5] Primary copied to replica.')
    })
  }

  replacePrimary () {
    log(`Replacing primary ${this.db1}...`)
    log('[0/8] Checking if primary is in use...')
    return this._isInUse(this.db1).then(() => {
      log('[1/8] Verifying primary and replica match...')
      return this._verifyReplica()
    }).then(() => {
      log('[2/8] Destroying primary...')
      return this._destroyDb(this.db1)
    }).then(() => {
      log('[3/8] Recreating primary with new settings...')
      return this._createDb(this.db1).then(() => {
        return new Promise((resolve) => {
          // sleep, giving the cluster a chance to sort
          // out the rapid recreation.
          const text = '[couch-continuum] Recreating (:bar) :percent :etas'
          const bar = new ProgressBar(text, {
            incomplete: ' ',
            width: 20,
            total: 150
          })
          const timer = setInterval(() => {
            bar.tick()
            if (bar.complete) {
              clearInterval(timer)
              return resolve()
            }
          }, 100)
        })
      })
    }).then(() => {
      log('[4/8] Setting primary to unavailable.')
      return this._setUnavailable()
    }).then(() => {
      log('[5/8] Beginning replication of replica to primary...')
      return this._replicate(this.db2, this.db1)
    }).then(() => {
      log('[6/8] Replicated. Destroying replica...')
      return this._destroyDb(this.db2)
    }).then(() => {
      log('[7/8] Setting primary to available.')
      return this._setAvailable()
    }).then(() => {
      log('[8/8] Primary migrated to new settings.')
    })
  }
}
