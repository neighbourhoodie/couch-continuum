const assert = require('assert')
const path = require('path')
const ProgressBar = require('progress')

const log = require('./lib/log')
const request = require('./lib/request')
const { name } = require('./package.json')
const { readFile, unlink, writeFile } = require('./lib/fs')

const checkpoint = path.join(__dirname, '.checkpoint')

module.exports =
class CouchContinuum {
  static async allDbs (url) {
    const allDbs = await request({ url: `${url}/_all_dbs`, json: true })
    return allDbs.filter((dbName) => {
      const isSpecial = (dbName[0] === '_') // ignore special dbs
      const isReplica = dbName.indexOf('_temp_copy') > -1
      return !isSpecial && !isReplica
    })
  }

  /**
   * Check the checkpoint file for an in-progress run
   * against a particular CouchDB cluster.
   * @return {Array<String>}  List of databases still to be migrated.
   */
  static async getCheckpoint () {
    return readFile(checkpoint, 'utf-8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '\u0000'
      } else {
        throw error
      }
    })
  }

  static async makeCheckpoint (dbName) {
    await writeFile(checkpoint, dbName, 'utf-8')
  }

  static async removeCheckpoint () {
    await unlink(checkpoint)
  }

  static async getRemaining (couchUrl) {
    const dbNames = await CouchContinuum.allDbs(couchUrl)
    const lastDb = await CouchContinuum.getCheckpoint()
    // ignore any databases that sort lower than
    // the name in the checkpoint doc.
    return dbNames.filter((dbName) => { return dbName > lastDb })
  }

  static async createReplicas (continuums) {
    for (let continuum of continuums) {
      await continuum.createReplica()
    }
  }

  static async replacePrimaries (continuums) {
    for (let continuum of continuums) {
      log('Replacing primary "%s" with replica "%s"', continuum.db1, continuum.db2)
      await continuum.replacePrimary()
      await CouchContinuum.makeCheckpoint(continuum.db1)
    }
    await CouchContinuum.removeCheckpoint()
  }

  constructor ({ couchUrl, dbName, copyName, filterTombstones, placement, interval, q, n }) {
    assert(couchUrl, 'The Continuum requires a URL for accessing CouchDB.')
    assert(dbName, 'The Continuum requires a target database.')
    this.url = couchUrl
    this.db1 = encodeURIComponent(dbName)
    this.db2 = copyName ? encodeURIComponent(copyName) : `${this.db1}_temp_copy`
    this.interval = interval || 1000
    this.q = q
    this.n = n
    this.placement = placement
    this.filterTombstones = filterTombstones
    const options = {
      db1: this.db1,
      db2: this.db2,
      interval: this.interval,
      q: this.q,
      n: this.n,
      placement: this.placement
    }
    log(`Created new continuum: ${JSON.stringify(options, undefined, 2)}`)
  }

  async _createDb (dbName) {
    const qs = {}
    if (this.q) { qs.q = this.q }
    if (this.n) { qs.n = this.n }
    if (this.placement) { qs.placement = this.placement }
    return request({ url: `${this.url}/${dbName}`, method: 'PUT', qs, json: true })
  }

  async _destroyDb (dbName) {
    return request({ url: `${this.url}/${dbName}`, method: 'DELETE', json: true })
  }

  async _replicate (source, target, selector) {
    const { doc_count: total } = await request({ url: `${this.url}/${source}`, json: true })
    if (total === 0) return null
    console.log(`[${name}] Replicating ${source} to ${target}`)
    const text = `[${name}] (:bar) :percent :etas`
    const bar = new ProgressBar(text, {
      incomplete: ' ',
      width: 20,
      total
    })
    var current = 0
    const timer = setInterval(async () => {
      const { doc_count: latest } = await request({
        url: `${this.url}/${target}`,
        json: true
      })
      const delta = latest - current
      bar.tick(delta)
      current = latest
      if (bar.complete) clearInterval(timer)
      // TODO catch errors produced by this loop
    }, this.interval)
    await request({
      url: `${this.url}/_replicate`,
      method: 'POST',
      json: { source, target, selector }
    })
    bar.tick(total)
    clearInterval(timer)
  }

  async _verifyReplica () {
    const { doc_count: docCount1 } = await request({
      url: `${this.url}/${this.db1}`,
      json: true
    })
    const { doc_count: docCount2 } = await request({
      url: `${this.url}/${this.db1}`,
      json: true
    })
    assert.strictEqual(docCount1, docCount2, 'Primary and replica do not have the same number of documents.')
  }

  async _isAvailable (dbName) {
    const { down } = await request({
      url: `${this.url}/${dbName || this.db1}/_local/in-maintenance`,
      json: true
    })
    return !down
  }

  async _setUnavailable () {
    await request({
      url: `${this.url}/${this.db1}/_local/in-maintenance`,
      method: 'PUT',
      json: { down: true }
    })
  }

  async _setAvailable () {
    const url = `${this.url}/${this.db1}/_local/in-maintenance`
    const { _rev: rev } = await request({ url, json: true })
    return request({ url, qs: { rev }, method: 'DELETE' })
  }

  /**
   * Retrieve the update sequence for a given database.
   * @param  {String} dbName  Name of the database to check.
   * @return {String}         The database's update sequence.
   */
  async _getUpdateSeq (dbName) {
    const { update_seq: updateSeq } = await request({
      url: `${this.url}/${dbName}`,
      json: true
    })
    return updateSeq
  }

  /**
   * Check if a database is still receiving updates or is
   * otherwise being monitored.
   * @param  {String}  dbName     Name of the database to check.
   * @return {Boolean}            Whether the database is in use.
   */
  async _isInUse (dbName) {
    const activeTasks = await request({
      url: [this.url, '_active_tasks'].join('/'),
      json: true
    })
    const { jobs } = await request({
      url: [this.url, '_scheduler', 'jobs'].join('/'),
      json: true
    }).then(({ jobs }) => {
      return { jobs: jobs || [] }
    })
    for (let { database } of [...jobs, ...activeTasks]) {
      assert.notEqual(database, dbName, `${dbName} is still in use.`)
    }
  }

  /**
   * Create a replica for the migration.
   * @return {Promise} Promise that resolves once
   *                   the replica has been created
   */
  async createReplica () {
    log(`Creating replica ${this.db2}...`)
    log('[0/5] Checking if primary is in use...')
    await this._isInUse(this.db1)
    const lastSeq1 = await this._getUpdateSeq(this.db1)
    log('[1/5] Creating replica db:', this.db2)
    await this._createDb(this.db2)
    log('[2/5] Beginning replication of primary to replica...')
    const selector = this.filterTombstones ? {
      _deleted: { $exists: false }
    } : undefined
    await this._replicate(this.db1, this.db2, selector)
    log('[3/5] Verifying primary did not change during replication...')
    const lastSeq2 = await this._getUpdateSeq(this.db1)
    assert(lastSeq1 <= lastSeq2, `${this.db1} is still receiving updates. Exiting...`)
    log('[4/5] Verifying primary and replica match...')
    await this._verifyReplica()
    log('[5/5] Primary copied to replica.')
  }

  async replacePrimary () {
    log(`Replacing primary ${this.db1}...`)
    log('[0/8] Checking if primary is in use...')
    await this._isInUse(this.db1)
    log('[1/8] Verifying primary and replica match...')
    await this._verifyReplica()
    log('[2/8] Destroying primary...')
    await this._destroyDb(this.db1)
    log('[3/8] Recreating primary with new settings...')
    await this._createDb(this.db1)
    await new Promise((resolve) => {
      // sleep, giving the cluster a chance to sort
      // out the rapid recreation.
      console.log(`[${name}] Recreating primary ${this.db1}`)
      const text = `[${name}] (:bar) :percent :etas`
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
    log('[4/8] Setting primary to unavailable.')
    await this._setUnavailable()
    log('[5/8] Beginning replication of replica to primary...')
    await this._replicate(this.db2, this.db1)
    log('[6/8] Replicated. Destroying replica...')
    await this._destroyDb(this.db2)
    log('[7/8] Setting primary to available.')
    await this._setAvailable()
    log('[8/8] Primary migrated to new settings.')
  }
}
