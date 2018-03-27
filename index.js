'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ProgressBar = require('progress')
const request = require('request')

const checkpoint = path.join(__dirname, '.checkpoint')
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
  static allDbs (url) {
    return makeRequest({
      url: [url, '_all_dbs'].join('/'),
      json: true
    }).then((body) => {
      return body.filter((dbName) => {
        const isSpecial = (dbName[0] === '_') // ignore special dbs
        const isReplica = dbName.indexOf('_temp_copy') > -1
        return !isSpecial && !isReplica
      })
    })
  }

  /**
   * Check the checkpoint file for an in-progress run
   * against a particular CouchDB cluster.
   * @param  {String} couchUrl Location of the CouchDB cluster
   * @return {Promise<Array>}  List of databases still to be migrated.
   */
  static getCheckpoint (couchUrl) {
    // skip already done
    return CouchContinuum.allDbs(couchUrl).then((dbNames) => {
      return new Promise((resolve, reject) => {
        fs.readFile(checkpoint, 'utf-8', (err, lastDb) => {
          if (err) {
            if (err.code === 'ENOENT') return resolve('\u0000')
            return reject(err)
          }
          return resolve(lastDb)
        })
      }).then((lastDb) => {
        // ignore any databases that sort lower than
        // the name in the checkpoint doc,
        // or the default: the lowest unicode value
        return dbNames.filter((dbName) => {
          return dbName > lastDb
        })
      })
    })
  }

  static makeCheckpoint (dbName) {
    return new Promise((resolve, reject) => {
      fs.writeFile(checkpoint, dbName, 'utf-8', (err) => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }

  static removeCheckpoint () {
    return new Promise((resolve, reject) => {
      fs.unlink(checkpoint, (err) => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }

  static createReplicas (continuums) {
    return continuums.map((continuum) => {
      return () => {
        return continuum.createReplica()
      }
    }).reduce((a, b) => {
      return a.then(b)
    }, Promise.resolve())
  }

  static replacePrimaries (continuums) {
    return continuums.map((continuum) => {
      return () => {
        log('Replacing primary "%s" with replica "%s"', continuum.db1, continuum.db2)
        return continuum.replacePrimary().then(() => {
          return CouchContinuum.makeCheckpoint(continuum.db1)
        })
      }
    }).reduce((a, b) => {
      return a.then(b)
    }, Promise.resolve())
  }

  constructor ({ couchUrl, dbName, copyName, filterTombstones, placement, interval, q }) {
    assert(couchUrl, 'The Continuum requires a URL for accessing CouchDB.')
    assert(dbName, 'The Continuum requires a target database.')
    this.url = couchUrl
    this.db1 = encodeURIComponent(dbName)
    this.db2 = (copyName && encodeURIComponent(copyName)) || (this.db1 + '_temp_copy')
    this.interval = interval || 1000
    this.q = q
    this.placement = placement
    this.filterTombstones = filterTombstones
    log('Created new continuum: %j', {
      db1: this.db1,
      db2: this.db2,
      interval: this.interval,
      q: this.q,
      placement: this.placement
    })
  }

  _createDb (dbName) {
    var qs = {}
    if (this.q) qs.q = this.q
    if (this.placement) qs.placement = this.placement
    return makeRequest({
      url: [this.url, dbName].join('/'),
      method: 'PUT',
      qs: qs,
      json: true
    })
  }

  _destroyDb (dbName) {
    return makeRequest({
      url: [this.url, dbName].join('/'),
      method: 'DELETE',
      json: true
    })
  }

  _replicate (source, target, selector) {
    return makeRequest({
      url: [this.url, source].join('/'),
      json: true
    }).then((body) => {
      const total = body.doc_count
      if (total === 0) return Promise.resolve()
      console.log('[couch-continuum] Replicating %s to %s', source, target)
      const text = '[couch-continuum] (:bar) :percent :etas'
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
        }).catch((error) => {
          if (error) console.error(error)
        })
      }, this.interval)
      return makeRequest({
        url: [this.url, '_replicate'].join('/'),
        method: 'POST',
        json: { source, target, selector }
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
      }).catch((error) => {
        // catch 1.x
        if (error.error === 'illegal_database_name') {
          return { jobs: [] }
        } else {
          throw error
        }
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
      var selector
      if (this.filterTombstones) selector = { _deleted: { '$exists': false } }
      return this._replicate(this.db1, this.db2, selector)
    }).then(() => {
      log('[3/5] Verifying primary did not change during replication...')
      return this._getUpdateSeq(this.db1).then((seq) => {
        lastSeq2 = seq
        assert(lastSeq1 <= lastSeq2, `${this.db1} is still receiving updates. Exiting...`)
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
          console.log('[couch-continuum] Recreating primary %s', this.db1)
          const text = '[couch-continuum] (:bar) :percent :etas'
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
